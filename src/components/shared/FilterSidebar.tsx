export interface RangeValue {
  min: number
  max: number
}

interface RangeSliderProps {
  label: string
  bounds: RangeValue
  step?: number
  unit?: string
  value: RangeValue
  onChange: (v: RangeValue) => void
}

/** Dual-handle numeric range filter, built from two overlaid native range inputs. */
export function RangeSlider({ label, bounds, step = 0.1, unit = '%', value, onChange }: RangeSliderProps) {
  return (
    <div className="filter-range">
      <div className="filter-range-head">
        <span className="filter-range-label">{label}</span>
        <span className="filter-range-value mono">{value.min}{unit} – {value.max}{unit}</span>
      </div>
      <div className="filter-range-track">
        <input
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={step}
          value={value.min}
          onChange={e => onChange({ min: Math.min(Number(e.target.value), value.max), max: value.max })}
        />
        <input
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={step}
          value={value.max}
          onChange={e => onChange({ min: value.min, max: Math.max(Number(e.target.value), value.min) })}
        />
      </div>
    </div>
  )
}

export interface CheckboxOption {
  key: string
  label: string
}

interface CertCheckboxGroupProps {
  label: string
  options: CheckboxOption[]
  selected: string[]
  onToggle: (key: string) => void
}

/** Compliance-gate checkbox group (e.g. EU-GMP / GACP / PIC/S). */
export function CertCheckboxGroup({ label, options, selected, onToggle }: CertCheckboxGroupProps) {
  return (
    <div className="filter-checkgroup">
      <div className="filter-range-label">{label}</div>
      {options.map(o => (
        <label key={o.key} className="filter-checkbox-row">
          <input type="checkbox" checked={selected.includes(o.key)} onChange={() => onToggle(o.key)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  )
}

interface FilterSidebarProps {
  title?: string
  children: React.ReactNode
  onReset?: () => void
}

export function FilterSidebar({ title = 'Filters', children, onReset }: FilterSidebarProps) {
  return (
    <aside className="filter-sidebar">
      <div className="filter-sidebar-head">
        <span className="filter-sidebar-title">{title}</span>
        {onReset && <button type="button" className="btn btn-ghost filter-reset" onClick={onReset}>Reset</button>}
      </div>
      {children}
    </aside>
  )
}
