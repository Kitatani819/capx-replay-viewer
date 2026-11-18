import React from 'react'
import ReactDOM from 'react-dom/client'
import TraceViewerPage from './trace/TraceViewerPage'
import { EvalDetailPage, EvalListPage } from './evals/EvalPages'
import './index.css'

const path = window.location.pathname.replace(/\/$/, '')
let page = <TraceViewerPage />
if (path === '/evals') page = <EvalListPage />
else if (/^\/evals\/[^/]+$/.test(path)) {
  let id = path.slice('/evals/'.length)
  try { id = decodeURIComponent(id) } catch { /* The API reports an invalid id. */ }
  page = <EvalDetailPage evalId={id} />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{page}</React.StrictMode>,
)
