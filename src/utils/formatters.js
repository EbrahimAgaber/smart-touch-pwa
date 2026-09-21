/**
 * src/utils/formatters.js — Smart Touch POS Saudi Currency & Number Formatters
 * P1.6: Uses 'ar-SA-u-nu-latn' locale extension to output Western Arabic (Latin)
 * numerals with ر.س currency symbol. Prevents Eastern Arabic/Hindi digits.
 * Reference: Report §4.3.1
 */

/**
 * Format a number as Saudi Riyals with Western Arabic digits.
 * e.g. formatSAR(14350.5) → "14,350.50 ر.س"
 */
export const formatSAR = (amount, options = {}) => {
  const num = typeof amount === 'string' ? parseFloat(amount) : (amount ?? 0);
  const safeNum = Number.isFinite(num) ? num : 0;

  return new Intl.NumberFormat('ar-SA-u-nu-latn', {
    style: 'currency',
    currency: 'SAR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...options
  }).format(safeNum);
};

/**
 * Returns structured parts for BiDi-safe rendering in CurrencyDisplay component.
 * Keeps the sign, digits, and unit as separate pieces so the LTR numeric run
 * can be isolated in its own DOM span.
 */
export const formatSARParts = (amount) => {
  const num = typeof amount === 'string' ? parseFloat(amount) : (amount ?? 0);
  const safeNum = Number.isFinite(num) ? num : 0;
  const isNegative = safeNum < 0;

  const formattedNumber = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Math.abs(safeNum));

  return {
    formattedNumber,
    isNegative,
    currencySymbol: 'ر.س',
    fullText: `${isNegative ? '-' : ''}${formattedNumber} ر.س`
  };
};

/**
 * Format a percentage change with sign.
 * e.g. formatPercent(12.3) → "+12.3%", formatPercent(-5) → "-5%"
 */
export const formatPercent = (percent) => {
  const num = typeof percent === 'string' ? parseFloat(percent) : (percent ?? 0);
  const safeNum = Number.isFinite(num) ? num : 0;
  const sign = safeNum > 0 ? '+' : (safeNum < 0 ? '-' : '');
  const absVal = Math.abs(safeNum).toFixed(1).replace(/\.0$/, '');
  return `${sign}${absVal}%`;
};

/**
 * Returns today's date string in Asia/Riyadh local time (YYYY-MM-DD).
 * P0.8: Use this everywhere instead of new Date().toISOString().split('T')[0].
 */
export const todayAST = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
