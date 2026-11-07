import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { paths } from '../../shared/paths.js';
import { ChromaMcpManager } from '../sync/ChromaMcpManager.js';

const PAGE_SIZE = 100;
const NO_COLLECTIONS = '__NO_COLLECTIONS_FOUND__';
const fold = (project: string): string => project.replace(/[A-Z]/g, char => char.toLowerCase());

export interface VectorPurgeOptions {
  dataDir: string;
}

export interface PreparedVectorPurge {
  listProjects(): Promise<string[]>;
  purgeProjects(projects: string[]): Promise<number>;
  close(): Promise<void>;
}

interface VectorDocument {
  id: string;
  project: string;
}

function parseDocuments(response: unknown, collection: string): VectorDocument[] {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error(`Invalid Chroma document response for ${collection}`);
  }
  const { ids, metadatas } = response as Record<string, unknown>;
  if (!Array.isArray(ids) || !Array.isArray(metadatas) || ids.length !== metadatas.length) {
    throw new Error(`Chroma did not return metadata for every document in ${collection}`);
  }
  return ids.map((id, index) => {
    const metadata = metadatas[index];
    if (typeof id !== 'string' || !id || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || typeof metadata.project !== 'string' || !metadata.project) {
      throw new Error(`Chroma document has no valid ID or project metadata in ${collection}`);
    }
    return { id, project: metadata.project };
  });
}

async function listCollections(manager: ChromaMcpManager): Promise<string[]> {
  const collections = new Set<string>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await manager.callTool('chroma_list_collections', { limit: PAGE_SIZE, offset });
    if (!Array.isArray(response) || response.length > PAGE_SIZE
      || response.some(name => typeof name !== 'string'
        || (name !== NO_COLLECTIONS && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/.test(name)))) {
      throw new Error('Invalid Chroma collection list response');
    }
    if (response.includes(NO_COLLECTIONS)) {
      if (response.length !== 1) throw new Error('Invalid Chroma empty collection marker');
      break;
    }
    for (const name of response as string[]) {
      if (collections.has(name)) throw new Error(`Chroma collection pagination repeated ${name}`);
      collections.add(name);
    }
    if (response.length < PAGE_SIZE) break;
  }
  return [...collections].filter(name => name.startsWith('cm__'));
}

async function scanCollection(manager: ChromaMcpManager, collection: string): Promise<VectorDocument[]> {
  const documents: VectorDocument[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await manager.callTool('chroma_get_documents', {
      collection_name: collection,
      include: ['metadatas'],
      limit: PAGE_SIZE,
      offset,
    });
    const page = parseDocuments(response, collection);
    if (page.length > PAGE_SIZE) throw new Error(`Invalid Chroma document page size in ${collection}`);
    for (const document of page) {
      if (seen.has(document.id)) throw new Error(`Chroma document pagination repeated ${document.id} in ${collection}`);
      seen.add(document.id);
      documents.push(document);
    }
    if (page.length < PAGE_SIZE) return documents;
  }
}

/** The caller must stop the local worker and reject remote Chroma before opening this session. */
export async function prepareVectorPurge(options: VectorPurgeOptions): Promise<PreparedVectorPurge | null> {
  const chromaDir = join(options.dataDir, 'chroma');
  let stat;
  try {
    stat = lstatSync(chromaDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Chroma data directory is not a regular directory: ${chromaDir}`);
  if (readdirSync(chromaDir).length === 0) return null;
  if (resolve(chromaDir) !== resolve(paths.chroma())) {
    throw new Error('Chroma data directory differs from the active CLI data directory');
  }

  const manager = ChromaMcpManager.getInstance();
  const inventory = new Map<string, VectorDocument[]>();
  try {
    const collections = await listCollections(manager);
    for (const collection of collections) inventory.set(collection, await scanCollection(manager, collection));
  } catch (error) {
    await manager.stop();
    throw error;
  }

  return {
    async listProjects() {
      const projects = new Map<string, string>();
      for (const documents of inventory.values()) {
        for (const { project } of documents) projects.set(fold(project), project);
      }
      return [...projects.values()].sort((a, b) => a.localeCompare(b));
    },
    async purgeProjects(projects) {
      const selected = new Set(projects.map(fold));
      let deleted = 0;
      for (const [collection, documents] of inventory) {
        const ids = documents.filter(document => selected.has(fold(document.project))).map(document => document.id);
        if (ids.length === 0) continue;
        for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
          const batch = ids.slice(offset, offset + PAGE_SIZE);
          // chroma-mcp returns plain confirmation text, which callTool decodes as null.
          await manager.callTool('chroma_delete_documents', { collection_name: collection, ids: batch });
          const remaining = parseDocuments(await manager.callTool('chroma_get_documents', {
            collection_name: collection,
            ids: batch,
            include: ['metadatas'],
          }), collection);
          if (remaining.length) throw new Error(`Chroma did not delete all requested documents in ${collection}`);
          deleted += batch.length;
        }
        const remaining = await scanCollection(manager, collection);
        if (remaining.some(document => selected.has(fold(document.project)))) {
          throw new Error(`Chroma still contains selected project documents in ${collection}`);
        }
        const retained = new Map(documents.filter(document => !selected.has(fold(document.project))).map(document => [document.id, document.project]));
        for (const document of remaining) {
          if (retained.get(document.id) !== document.project) throw new Error(`Chroma documents changed during project deletion in ${collection}`);
          retained.delete(document.id);
        }
        if (retained.size) throw new Error(`Chroma removed unrelated project documents in ${collection}`);
      }
      return deleted;
    },
    close: () => manager.stop(),
  };
}
