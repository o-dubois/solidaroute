/**
 * StarDisplay — read-only star rating display.
 * Shows filled/half/empty stars for a 1–5 rating.
 *
 * Props:
 *   rating — numeric rating (1–5, decimals supported)
 *   size   — 'sm' (default) | 'lg'
 */
export function StarDisplay({ rating = 0, size = 'sm' }) {
  const textSize = size === 'lg' ? 'text-xl' : 'text-sm';
  return (
    <div className={`flex items-center gap-0.5 ${textSize}`}>
      {[1, 2, 3, 4, 5].map(i => {
        const filled = rating >= i;
        const half   = !filled && rating >= i - 0.5;
        return (
          <span key={i} className={filled ? 'text-amber-400' : half ? 'text-amber-300' : 'text-gray-300'}>
            ★
          </span>
        );
      })}
    </div>
  );
}

/**
 * StarInput — interactive star rating picker.
 *
 * Props:
 *   value    — current rating (1–5)
 *   onChange — callback(newRating)
 *   disabled — disables interaction
 */
export function StarInput({ value = 0, onChange, disabled = false }) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map(i => (
        <button
          key={i}
          type="button"
          disabled={disabled}
          onClick={() => !disabled && onChange(i)}
          className={`text-2xl transition-colors leading-none
            ${disabled ? 'cursor-default' : 'cursor-pointer hover:scale-110'}
            ${i <= value ? 'text-amber-400' : 'text-gray-300 hover:text-amber-300'}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}
