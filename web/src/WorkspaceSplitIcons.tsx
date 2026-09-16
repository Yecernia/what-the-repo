import { penPath } from './pen-path';

const gripFrame = penPath([[6,4,.8],[24,3.6,1],[42,4.2,.9],[44,10,.95],[42,15.5,.8],[24,16,1.1],[6,15.4,.85],[4,10,1]], 1.2, true);
const gripLines = [penPath([[14,8,.7],[24,7.7,1],[34,8.2,.75]], 1.4), penPath([[15,11.7,.7],[25,12.2,1],[33,11.8,.8]], 1.4)];
export function SplitGripIcon() {
  return <svg className="workspace-divider-grip" width="48" height="20" viewBox="0 0 48 20" aria-hidden="true" focusable="false">
    <path d="M6 4 Q24 3 42 4 Q46 10 42 16 Q24 17 6 16 Q2 10 6 4Z" fill="var(--panel-strong)" />
    {[gripFrame, ...gripLines].map((d, i) => <path key={i} d={d} fill="currentColor" fillRule="evenodd" />)}
  </svg>;
}
