/**
 * src/components/CurrencyDisplay.jsx
 * P1.6: BiDi-safe Saudi Riyal display component.
 *
 * Problem: Under Unicode BiDi Algorithm (UAX #9), negative amounts like
 * "-65.00 ر.س" can render as "65.00- ر.س" in an RTL context, inverting the sign.
 *
 * Solution: Isolate the numeric run in a dir="ltr" inner span inside an outer
 * dir="rtl" wrapper. The sign stays attached to the number, not the currency unit.
 *
 * DOM structure:
 *   <span dir="rtl">
 *     <span dir="ltr" class="font-mono tabular-nums">-65.00</span>
 *     <span>ر.س</span>
 *   </span>
 */
import React from 'react';
import { formatSARParts } from '../utils/formatters';

export function CurrencyDisplay({
  amount,
  size = 'md',      // 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  color = 'default', // 'default' | 'danger' | 'success' | 'muted' | 'white'
  showSign = false,
  className = ''
}) {
  const { formattedNumber, isNegative } = formatSARParts(amount);

  const sizeClass = {
    xs: 'text-xs',
    sm: 'text-sm',
    md: 'text-base font-bold',
    lg: 'text-xl font-black',
    xl: 'text-3xl sm:text-4xl font-black'
  }[size] ?? 'text-base font-bold';

  const colorClass = {
    default: 'text-main',
    danger:  'text-red-500',
    success: 'text-emerald-600',
    muted:   'text-muted',
    white:   'text-white'
  }[color] ?? 'text-main';

  const displayValue = isNegative
    ? `-${formattedNumber}`
    : (showSign && parseFloat(amount) > 0 ? `+${formattedNumber}` : formattedNumber);

  return (
    <span
      className={`inline-flex items-baseline gap-1 select-none ${className}`}
      dir="rtl"
    >
      {/* LTR run: locks the sign to the number, prevents BiDi inversion */}
      <span
        dir="ltr"
        className={`font-mono tabular-nums tracking-tight ${sizeClass} ${colorClass}`}
      >
        {displayValue}
      </span>

      {/* Currency unit in natural RTL position */}
      <span className="text-[11px] sm:text-xs font-semibold opacity-85 text-inherit">
        ر.س
      </span>
    </span>
  );
}

export default CurrencyDisplay;
