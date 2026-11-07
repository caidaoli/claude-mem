import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../../src/shared/paths.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ChromaMcpManager } from '../../src/services/sync/ChromaMcpManager.js';
import { prepareVectorPurge } from '../../src/services/project-memory/vectors.js';

type Document = { id: string; project: string };
type Call = { tool: string; args: Record<string, any> };

let dataDir: string;
let corpus: Map<string, Document[]>;
let calls: Call[];
let getResponse: ((args: Record<string, any>) => unknown) | undefined;
let listResponse: unknown;
let deletion: 'normal' | 'noop' | 'wipe' | 'fail';
let factorySpy: ReturnType<typeof spyOn>;
let pathSpy: ReturnType<typeof spyOn>;
let settingsSpy: ReturnType<typeof spyOn> | undefined;
let enabled: string | undefined;

const stop = mock(async () => {});
const fakeManager = {
  stop,
  async callTool(tool: string, args: Record<string, any>): Promise<unknown> {
    calls.push({ tool, args });
    if (tool === 'chroma_list_collections') {
      if (listResponse !== undefined) return listResponse;
      const names = [...corpus.keys()].slice(args.offset, args.offset + args.limit);
      return names.length ? names : ['__NO_COLLECTIONS_FOUND__'];
    }
    const documents = corpus.get(args.collection_name)!;
    if (tool === 'chroma_get_documents') {
      if (getResponse) return getResponse(args);
      const page = args.ids
        ? documents.filter(document => args.ids.includes(document.id))
        : documents.slice(args.offset, args.offset + args.limit);
      return { ids: page.map(document => document.id), metadatas: page.map(document => ({ project: document.project })) };
    }
    if (tool === 'chroma_delete_documents') {
      if (deletion === 'fail') throw new Error('Chroma delete unavailable');
      if (deletion !== 'noop') corpus.set(args.collection_name, deletion === 'wipe' ? [] : documents.filter(document => !args.ids.includes(document.id)));
      return null;
    }
    throw new Error(`Unexpected Chroma tool ${tool}`);
  },
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'project-memory-vectors-'));
  mkdirSync(join(dataDir, 'chroma'));
  writeFileSync(join(dataDir, 'chroma', 'chroma.sqlite3'), 'mock Chroma index');
  calls = [];
  corpus = new Map();
  getResponse = undefined;
  listResponse = undefined;
  deletion = 'normal';
  stop.mockClear();
  factorySpy = spyOn(ChromaMcpManager, 'getInstance').mockReturnValue(fakeManager as unknown as ChromaMcpManager);
  pathSpy = spyOn(paths, 'chroma').mockImplementation(() => join(dataDir, 'chroma'));
  enabled = process.env.CLAUDE_MEM_CHROMA_ENABLED;
});

afterEach(() => {
  factorySpy.mockRestore();
  pathSpy.mockRestore();
  settingsSpy?.mockRestore();
  settingsSpy = undefined;
  if (enabled === undefined) delete process.env.CLAUDE_MEM_CHROMA_ENABLED;
  else process.env.CLAUDE_MEM_CHROMA_ENABLED = enabled;
  rmSync(dataDir, { recursive: true, force: true });
});

const options = () => ({ dataDir });
const deleteCalls = () => calls.filter(call => call.tool === 'chroma_delete_documents');

async function listProjects(): Promise<string[]> {
  const prepared = await prepareVectorPurge(options());
  if (!prepared) return [];
  try {
    return await prepared.listProjects();
  } finally {
    await prepared.close();
  }
}

describe('project vector deletion', () => {
  it('lists projects from the shared and historical collections without a SQLite row', async () => {
    corpus.set('cm__claude-mem', [{ id: 'orphan', project: 'deleted-core-project' }]);
    corpus.set('cm__historical', [{ id: 'old', project: 'history-only-project' }]);
    corpus.set('someone-elses-collection', [{ id: 'other', project: 'unrelated' }]);

    expect(await listProjects()).toEqual(['deleted-core-project', 'history-only-project']);
    expect(calls.filter(call => call.tool === 'chroma_get_documents').map(call => call.args.collection_name))
      .toEqual(['cm__claude-mem', 'cm__historical']);
    expect(deleteCalls()).toEqual([]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('deletes selected projects in pages, including case variants and orphan documents, while preserving other projects', async () => {
    process.env.CLAUDE_MEM_CHROMA_ENABLED = 'false';
    const selected = Array.from({ length: 205 }, (_, index) => ({ id: `orphan-${index}`, project: index % 2 ? 'Alpha' : 'alpha' }));
    corpus.set('cm__claude-mem', [...selected.slice(0, 50), { id: 'keep', project: 'beta' }, ...selected.slice(50)]);
    corpus.set('cm__legacy-alpha', [{ id: 'legacy-orphan', project: 'ALPHA' }, { id: 'legacy-keep', project: 'beta' }]);
    corpus.set('unrelated-collection', [{ id: 'not-owned', project: 'alpha' }]);
    const prepared = await prepareVectorPurge(options());

    try {
      expect(await prepared!.purgeProjects(['alpha'])).toBe(206);
      expect(deleteCalls().map(call => call.args.ids.length)).toEqual([100, 100, 5, 1]);
      expect(corpus.get('cm__claude-mem')).toEqual([{ id: 'keep', project: 'beta' }]);
      expect(corpus.get('cm__legacy-alpha')).toEqual([{ id: 'legacy-keep', project: 'beta' }]);
      expect(corpus.get('unrelated-collection')).toEqual([{ id: 'not-owned', project: 'alpha' }]);
      expect(calls.every(call => call.tool !== 'chroma_delete_collection')).toBe(true);
      expect(calls.some(call => call.tool === 'chroma_get_documents' && call.args.offset === 200)).toBe(true);
    } finally {
      await prepared!.close();
    }
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('paginates collection enumeration and recognizes the real empty-page marker', async () => {
    for (let index = 0; index < 100; index++) corpus.set(`cm__collection-${index}`, []);
    corpus.set('cm__last', [{ id: 'last', project: 'last-project' }]);
    expect(await listProjects()).toEqual(['last-project']);
    expect(calls.filter(call => call.tool === 'chroma_list_collections').map(call => call.args.offset)).toEqual([0, 100]);
    corpus.clear();
    expect(await listProjects()).toEqual([]);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('does not launch an index when it is absent or empty', async () => {
    rmSync(join(dataDir, 'chroma'), { recursive: true });
    expect(await prepareVectorPurge(options())).toBeNull();
    mkdirSync(join(dataDir, 'chroma'));
    expect(await prepareVectorPurge(options())).toBeNull();
    expect(factorySpy).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('rejects a different data directory before opening Chroma', async () => {
    mkdirSync(join(dataDir, 'wrong', 'chroma'), { recursive: true });
    writeFileSync(join(dataDir, 'wrong', 'chroma', 'chroma.sqlite3'), 'mock Chroma index');
    await expect(prepareVectorPurge({ dataDir: join(dataDir, 'wrong') })).rejects.toThrow('differs');
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it('allows an absent or empty index in a data directory that differs from the imported paths', async () => {
    const other = join(dataDir, 'no-index');
    expect(await prepareVectorPurge({ dataDir: other })).toBeNull();
    mkdirSync(join(other, 'chroma'), { recursive: true });
    expect(await prepareVectorPurge({ dataDir: other })).toBeNull();
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it('rejects a symlinked index directory before opening Chroma', async () => {
    rmSync(join(dataDir, 'chroma'), { recursive: true });
    mkdirSync(join(dataDir, 'elsewhere'));
    symlinkSync(join(dataDir, 'elsewhere'), join(dataDir, 'chroma'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(prepareVectorPurge(options())).rejects.toThrow('not a regular directory');
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it.each([null, {}, { collections: ['cm__alpha'] }, ['__NO_COLLECTIONS_FOUND__', 'cm__alpha'], ['invalid response']])
    ('rejects an unknown collection response before deleting: %j', async response => {
      listResponse = response;
      await expect(prepareVectorPurge(options())).rejects.toThrow('Chroma');
      expect(deleteCalls()).toEqual([]);
      expect(stop).toHaveBeenCalledTimes(1);
    });

  it.each([null, {}, { ids: ['one'] }, { ids: ['one'], metadatas: [] }, { ids: ['one'], metadatas: [null] },
    { ids: ['one'], metadatas: [{}] }, { ids: [42], metadatas: [{ project: 'alpha' }] }])
    ('rejects unknown or incomplete document metadata before deleting: %j', async response => {
      corpus.set('cm__claude-mem', [{ id: 'one', project: 'alpha' }]);
      getResponse = () => response;
      await expect(prepareVectorPurge(options())).rejects.toThrow('Chroma');
      expect(deleteCalls()).toEqual([]);
      expect(stop).toHaveBeenCalledTimes(1);
    });

  it('rejects repeated document pages instead of looping or deleting an incomplete snapshot', async () => {
    corpus.set('cm__claude-mem', []);
    getResponse = () => ({ ids: Array.from({ length: 100 }, (_, index) => `id-${index}`), metadatas: Array.from({ length: 100 }, () => ({ project: 'alpha' })) });
    await expect(prepareVectorPurge(options())).rejects.toThrow('pagination repeated');
    expect(deleteCalls()).toEqual([]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it.each(['noop', 'wipe', 'fail'] as const)('reports deletion failures and closes the child: %s', async mode => {
    corpus.set('cm__claude-mem', [{ id: 'selected', project: 'alpha' }, { id: 'retained', project: 'beta' }]);
    deletion = mode;
    const prepared = await prepareVectorPurge(options());
    try {
      await expect(prepared!.purgeProjects(['alpha'])).rejects.toThrow(mode === 'noop' ? 'did not delete' : mode === 'wipe' ? 'unrelated' : 'unavailable');
    } finally {
      await prepared!.close();
    }
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown deletion verification response', async () => {
    corpus.set('cm__claude-mem', [{ id: 'selected', project: 'alpha' }]);
    const prepared = await prepareVectorPurge(options());
    getResponse = () => null;
    try {
      await expect(prepared!.purgeProjects(['alpha'])).rejects.toThrow('Invalid Chroma document response');
    } finally {
      await prepared!.close();
    }
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('requires a final scan with no selected project documents after per-ID verification succeeds', async () => {
    corpus.set('cm__claude-mem', [{ id: 'selected', project: 'alpha' }]);
    const prepared = await prepareVectorPurge(options());
    getResponse = args => args.ids
      ? { ids: [], metadatas: [] }
      : { ids: ['unseen-selected'], metadatas: [{ project: 'alpha' }] };
    try {
      await expect(prepared!.purgeProjects(['alpha'])).rejects.toThrow('still contains selected project documents');
    } finally {
      await prepared!.close();
    }
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('Chroma collection list MCP decoding', () => {
  async function decode(content: unknown): Promise<unknown> {
    settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({ ...SettingsDefaultsManager.DEFAULTS });
    const Manager = ChromaMcpManager as unknown as new () => ChromaMcpManager;
    const manager = new Manager();
    Object.assign(manager, { connected: true, client: { callTool: async () => ({ content }) } });
    return manager.callTool('chroma_list_collections', { limit: 100, offset: 0 });
  }

  it('reads every FastMCP 1.6 text block as a collection name', async () => {
    expect(await decode([{ type: 'text', text: 'cm__claude-mem' }, { type: 'text', text: 'cm__legacy' }]))
      .toEqual(['cm__claude-mem', 'cm__legacy']);
  });

  it('reads the FastMCP empty marker', async () => {
    expect(await decode([{ type: 'text', text: '__NO_COLLECTIONS_FOUND__' }])).toEqual(['__NO_COLLECTIONS_FOUND__']);
  });

  it('also decodes a single JSON-encoded collection array', async () => {
    expect(await decode([{ type: 'text', text: '["cm__claude-mem","cm__legacy"]' }])).toEqual(['cm__claude-mem', 'cm__legacy']);
  });

  it('rejects mixed non-text content', async () => {
    await expect(decode([{ type: 'text', text: 'cm__claude-mem' }, { type: 'resource', resource: {} }])).rejects.toThrow('invalid collection list');
  });
});
