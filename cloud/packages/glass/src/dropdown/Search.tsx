import { Search as SearchIcon, X } from 'lucide-react';
import React from 'react';
import { SEARCH_MARKER, useGlassDropdownContext } from './context';
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
    <div
      data-slot="dropdown-search"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 10px',
        margin: '0 0 4px 0',
        borderRadius: '12px',
        background: 'var(--paper-fill-1)',
        border: '1px solid var(--paper-hairline)',
      }}
    >
      <SearchIcon
        size={14}
        style={{ color: 'var(--paper-muted-ink)', flexShrink: 0 }}
      />
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
        style={{
          flex: 1,
          minWidth: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--paper-ink)',
          fontFamily: 'var(--font-sans)',
          fontSize: '13px',
          lineHeight: '18px',
          outline: 'none',
          ...style,
        }}
        {...rest}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onValueChange('')}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--paper-muted-ink)',
            padding: 2,
            display: 'inline-flex',
            cursor: 'pointer',
          }}
        >
          <X size={13} />
        </button>
      ) : null}
    </div>
  );
});
(Search as unknown as { [SEARCH_MARKER]: boolean })[SEARCH_MARKER] = true;

export { Search };
