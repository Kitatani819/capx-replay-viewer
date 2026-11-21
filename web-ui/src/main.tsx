import React from 'react'
import ReactDOM from 'react-dom/client'
import TraceViewerPage from './trace/TraceViewerPage'
import SideBySidePage from './trace/SideBySidePage'
import { EvalDetailPage, EvalListPage } from './evals/EvalPages'
import './index.css'
import { currentSiteName } from './navigation/site'

currentSiteName()

const path = window.location.pathname.replace(/\/$/, '')
let page = <TraceViewerPage />
if (path === '/traces/compare') page = <SideBySidePage />
else if (path === '/evals') page = <EvalListPage />
else if (/^\/evals\/[^/]+$/.test(path)) {
  let id = path.slice('/evals/'.length)
  try { id = decodeURIComponent(id) } catch { /* The API reports an invalid id. */ }
  page = <EvalDetailPage evalId={id} />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{page}</React.StrictMode>,
)
