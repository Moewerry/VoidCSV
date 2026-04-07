import React, { useEffect, useMemo, useRef, useState } from 'react'

export type CustomSelectOption = {
  value: string
  label: React.ReactNode
}

type Props = {
  value: string
  options: CustomSelectOption[]
  onChange: (value: string) => void
  ariaLabel?: string
  disabled?: boolean
}

export default function CustomSelect(props: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  const selected = useMemo(() => {
    return props.options.find((o) => o.value === props.value) || props.options[0]
  }, [props.options, props.value])

  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      if (!open) return
      const el = rootRef.current
      if (!el) return
      if (e.target instanceof Node && el.contains(e.target)) return
      setOpen(false)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!open) return
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }

    document.addEventListener('pointerdown', onDocPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="cselect" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="cselect-btn"
        aria-label={props.ariaLabel || 'select'}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => {
          if (props.disabled) return
          setOpen((v) => !v)
        }}
      >
        <span className="cselect-value">{selected?.label}</span>
        <span className="cselect-arrow" />
      </button>

      {open ? (
        <div className="cselect-menu" role="listbox" aria-label={props.ariaLabel || 'select'}>
          {props.options.map((opt) => {
            const active = opt.value === props.value
            return (
              <div
                key={opt.value}
                role="option"
                aria-selected={active}
                className={`cselect-item ${active ? 'active' : ''}`}
                onClick={() => {
                  props.onChange(opt.value)
                  setOpen(false)
                  buttonRef.current?.focus()
                }}
              >
                {opt.label}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

