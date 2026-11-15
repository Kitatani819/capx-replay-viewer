/** Recorded I/O grouped by the selected process, reusing the diagnostic renderers. */
import { useState, type ReactNode } from 'react';
import type { TabProps } from '../DetailTabs';
import { NO_ASSET_STATES } from '../DataAssetState';
import { SectionTitle } from '../common';
import { ApiLogTab } from './ApiLogTab';
import { DebugTab, Perception } from './DebugTab';
import { InputDiffTab } from './InputDiffTab';
import { ModelInputTab } from './ModelInputTab';
import { ModelOutputTab } from './ModelOutputTab';

function Supplemental({ title, children, lazy = false }: { title: string; children: ReactNode; lazy?: boolean }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={e => setOpen(e.currentTarget.open)} className="border-t border-surface-border pt-2">
    <summary className="cursor-pointer text-xs text-text-secondary">{title}</summary>
    {(!lazy || open) && <div className="mt-3">{children}</div>}
  </details>;
}

export function InputOutputTab(props: TabProps) {
  const { node } = props.selection;
  const isModel = node.kind === 'model_call';
  const isExecution = ['code_block', 'api_call', 'stdout', 'stderr'].includes(node.kind);
  const isService = node.kind === 'service_call';
  return <div className="space-y-5" data-process-io={node.kind}>
    {isModel ? <>
      <section aria-label="実行時のモデル入力">
        <SectionTitle>{node.call?.role === 'vdm' ? 'VDMに渡した指示・比較画像' : '実際に渡したプロンプト・画像・ログ'}</SectionTitle>
        <ModelInputTab {...props}/>
      </section>
      <section aria-label="実行時のモデル出力">
        <SectionTitle>{node.call?.role === 'vdm' ? 'VDMが返した説明' : 'モデルが返した回答'}</SectionTitle>
        <ModelOutputTab {...props}/>
      </section>
      <Supplemental title="前の入力との差分"><InputDiffTab {...props}/></Supplemental>
    </> : isService ? <>
      <Perception ep={props.ep} node={node} assetStates={props.assetStates ?? NO_ASSET_STATES} onRetryAsset={props.onRetryAsset}/>
      <ApiLogTab {...props}/>
    </> : isExecution ? <>
      <ApiLogTab {...props}/>
      <Perception ep={props.ep} node={node} assetStates={props.assetStates ?? NO_ASSET_STATES} onRetryAsset={props.onRetryAsset}/>
      <Supplemental title="関連するモデル入力"><ModelInputTab {...props}/></Supplemental>
    </> : <DebugTab {...props}/>}
    {(isModel || isService || isExecution) && <Supplemental title="評価・デバッグ情報・記録の詳細" lazy><DebugTab {...props}/></Supplemental>}
  </div>;
}
