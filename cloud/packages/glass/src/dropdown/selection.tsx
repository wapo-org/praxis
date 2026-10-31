import React from 'react';
import { Item, type ItemProps } from './Item';
export interface CheckboxItemProps extends Omit<
  ItemProps,
  'selected' | 'onSelect'
> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

const CheckboxItem = React.forwardRef<HTMLButtonElement, CheckboxItemProps>(
  function CheckboxItem(
    { checked, onCheckedChange, keepOpen = true, ...rest },
    ref,
  ) {
    return (
      <Item
        ref={ref}
        role="menuitemcheckbox"
        aria-checked={checked}
        selected={checked}
        keepOpen={keepOpen}
        onSelect={() => onCheckedChange(!checked)}
        {...rest}
      />
    );
  },
);

interface RadioGroupContextValue {
  value: string;
  onValueChange: (val: string) => void;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(
  null,
);

export interface RadioGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  onValueChange: (val: string) => void;
}

function RadioGroup({
  value,
  onValueChange,
  children,
  ...rest
}: RadioGroupProps) {
  const ctx = React.useMemo(
    () => ({ value, onValueChange }),
    [value, onValueChange],
  );
  return (
    <RadioGroupContext.Provider value={ctx}>
      <div role="group" {...rest}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
}

export interface RadioItemProps extends Omit<
  ItemProps,
  'selected' | 'onSelect' | 'value'
> {
  value: string;
}

const RadioItem = React.forwardRef<HTMLButtonElement, RadioItemProps>(
  function RadioItem({ value, ...rest }, ref) {
    const group = React.useContext(RadioGroupContext);
    const selected = group?.value === value;
    return (
      <Item
        ref={ref}
        role="menuitemradio"
        aria-checked={selected}
        selected={selected}
        onSelect={() => group?.onValueChange(value)}
        {...rest}
      />
    );
  },
);

export { CheckboxItem, RadioGroup, RadioItem };
