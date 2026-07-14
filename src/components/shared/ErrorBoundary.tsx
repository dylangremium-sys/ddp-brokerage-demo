import { Component, type ReactNode } from 'react'
import { logClientError, newRequestId } from '../../lib/observability'

// ─── Top-level error boundary (P0-B) ────────────────────────────────────────
//
// The app had none. An uncaught render or lifecycle error therefore unmounted the
// whole React tree and left the operator staring at a blank white page, with no
// signal emitted anywhere. This catches that, shows a calm fallback, and logs one
// privacy-safe event.
//
// Note what these two methods do NOT declare: parameters. React passes the error
// and the component stack to both, and by simply not accepting them this class
// makes it *structurally impossible* for the error's message, its stack, or the
// component stack to reach the state, the rendered output, or the log. There is no
// scrubbing step to get wrong, and no future edit can leak them by accident
// without first adding a parameter back.

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  /** A reference code shown to the user and emitted in the log line, so a support
   *  report can be tied to the event. Random — it encodes nothing about them. */
  reference: string | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, reference: null }

  static getDerivedStateFromError(): State {
    return { hasError: true, reference: newRequestId() }
  }

  componentDidCatch(): void {
    logClientError({
      event: 'ui_crash',
      requestId: this.state.reference ?? newRequestId(),
      category: 'render_error',
      route: 'app_root',
    })
  }

  private readonly handleReload = (): void => {
    // A plain reload, nothing more. Storage is deliberately NOT cleared and the
    // user is deliberately NOT signed out: a render bug is not evidence of a
    // compromised session, and destroying their state on the way out would turn a
    // recoverable glitch into lost work. Sign-out clearing stays where it belongs,
    // in services/auth.ts.
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children

    return (
      <div role="alert" className="error-boundary">
        <h1>Something went wrong</h1>
        <p>
          This page could not be displayed. Your data has not been changed, and you are still
          signed in.
        </p>
        <p>Reloading usually resolves it. If it keeps happening, quote this reference:</p>
        <p>
          <code>{this.state.reference}</code>
        </p>
        <button type="button" onClick={this.handleReload}>
          Reload the page
        </button>
      </div>
    )
  }
}
