/**
 * The product name, "SPARK CALLBACK": a four-point spark followed by the name in heavy, widely spaced capitals, in the brand red.
 * It is plain text (not an image) so it stays crisp at any size and follows the light/dark theme.
 */
interface Props {
  className?: string
  /** Cap height in px, roughly the old logo height; the text scales with it. */
  height?: number
  /** Kept so the old call sites that place the logo inside an SVG scene still compile. */
  x?: number
  y?: number
}

export function SparkWordmark({ className = '', height = 20 }: Props) {
  const size = Math.round(height * 0.78)
  return (
    <span className={`brand ${className}`.trim()} style={{ fontSize: size }} role="img" aria-label="Spark Callback">
      <svg className="brand__spark" viewBox="-50 -50 100 100" width={size * 1.15} height={size * 1.15} aria-hidden="true">
        <path d="M0-50C5-15 15-5 50 0 15 5 5 15 0 50-5 15-15 5-50 0-15-5-5-15 0-50Z" fill="currentColor" />
      </svg>
      <span className="brand__name" aria-hidden="true">SPARK CALLBACK</span>
    </span>
  )
}
