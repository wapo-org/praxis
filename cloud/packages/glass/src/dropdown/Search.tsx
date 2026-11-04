import { Search as SearchIcon, X } from '../icons';
import React from 'react';
import { SEARCH_MARKER, useGlassDropdownContext } from './context';
import styles from './dropdown.module.css';
export interface SearchProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'onChange'
> {
  value: string;
  onValueChange: (next: string) => void;
}

const Search = React.forwardRef<HTMLInputElement, SearchProps>(function Search(
  { value, onValueChange, placeholder = 'Filter…', style, ...rest },
  ref,
) {
  const ctx = useGlassDropdownContext('Search');
  return (
    <div data-slot="dropdown-search" className={styles.search}>
      <SearchIcon size={16} />
      <input
        ref={ref}
        type="text"
        role="combobox"
        aria-label={rest['aria-label'] ?? placeholder}
        aria-autocomplete="list"
        aria-expanded={ctx.open}
        aria-controls={`${ctx.menuId}-listbox`}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder}
        className={styles.searchInput}
        style={style}
        {...rest}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onValueChange('')}
          className={styles.searchClear}
        >
          <X size={16} />
        </button>
      ) : null}
    </div>
  );
});
(Search as unknown as { [SEARCH_MARKER]: boolean })[SEARCH_MARKER] = true;

export { Search };
