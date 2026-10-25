import React from 'react';
import { CATEGORY_ORDER } from '../utils/category';
import { useI18n } from '../i18n';

interface CategoryFilterProps {
  categoryCounts: Record<string, number>;
  activeCategories: Set<string>;
  onToggle: (category: string) => void;
  filteredCount: number;
  totalCount: number;
  totalIsPartial: boolean;
}

export function CategoryFilter({
  categoryCounts,
  activeCategories,
  onToggle,
  filteredCount,
  totalCount,
  totalIsPartial,
}: CategoryFilterProps) {
  const { t } = useI18n();
  const presentCategories = CATEGORY_ORDER.filter(category => (categoryCounts[category] ?? 0) > 0);

  if (presentCategories.length === 0) {
    return null;
  }

  return (
    <div className="category-filter-bar">
      <div className="console-filter-chips">
        {presentCategories.map(category => (
          <button
            key={category}
            className={`console-filter-chip ${activeCategories.has(category) ? 'active' : ''}`}
            onClick={() => onToggle(category)}
            title={t.categoryFilter.filterTo.replace('{category}', t.categoryFilter.categories[category])}
            aria-pressed={activeCategories.has(category)}
          >
            {t.categoryFilter.categories[category]} ({categoryCounts[category]})
          </button>
        ))}
      </div>
      <span className="category-filter-count">
        {t.categoryFilter.count
          .replace('{filtered}', String(filteredCount))
          .replace('{total}', `${totalCount}${totalIsPartial ? '+' : ''}`)}
      </span>
    </div>
  );
}
