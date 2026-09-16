import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {AnalysisStatus,Pagination,RepositoryUsers} from './AdminRepositoryViews';
import {adminRequest} from './admin-api';
vi.mock('./admin-api',()=>({adminRequest:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('distinguishes queued, running and failed analyses',()=>{
  const {container}=render(<><AnalysisStatus row={{status:'queued'}}/><AnalysisStatus row={{status:'running'}}/><AnalysisStatus row={{status:'failed'}}/></>);
  expect(container.querySelector('.is-queued')?.parentElement?.textContent).toBe('排队中');
  expect(container.querySelector('.is-active')?.parentElement?.textContent).toBe('正在分析');
  expect(container.querySelector('.is-failed')?.parentElement?.textContent).toBe('失败');
});
it('jumps to a chosen page and rejects out-of-range pages',()=>{
  const change=vi.fn();render(<Pagination value={{page:1,pages:4,total:80}} onChange={change} label="用户"/>);
  const input=screen.getByRole('spinbutton');
  fireEvent.change(input,{target:{value:'3'}});fireEvent.submit(input.closest('form')!);expect(change).toHaveBeenLastCalledWith(3);
  change.mockClear();fireEvent.change(input,{target:{value:'5'}});fireEvent.submit(input.closest('form')!);expect(change).not.toHaveBeenCalled();
});
it('shows two names, then opens all users in a dialog',async()=>{
  const users=[0,1,2].map(i=>({owner_id:'github:'+i,login:'member-'+i,online:i===0}));
  vi.mocked(adminRequest).mockResolvedValue({users});
  render(<RepositoryUsers row={{repository_identity:'org/repo',user_count:3,users}} kind="storage"/>);
  expect(screen.queryByText('member-2')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'展开全部 3 位用户'}));
  const dialog=screen.getByRole('dialog');expect(await within(dialog).findByText('member-2')).toBeTruthy();
  expect(within(dialog).getByLabelText('在线')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button',{name:'关闭'}));expect(screen.queryByRole('dialog')).toBeNull();
});

it.each(['idle','queued','done','failed',undefined])('running execution overrides outdated project stage %s',stage=>{
  render(<AnalysisStatus row={{status:'running',stage}}/>);
  expect(screen.getByText('正在分析')).toBeTruthy();
  expect(screen.queryByText('排队中')).toBeNull();
});
it.each([['queued','排队中'],['succeeded','已完成'],['failed','失败'],['cancelled','已取消']])('execution state %s is not overridden by project progress',(status,label)=>{
  render(<AnalysisStatus row={{status,stage:'interpreting'}}/>);
  expect(screen.getByText(label)).toBeTruthy();
});
it('running execution retains a current analysis phase',()=>{
  render(<AnalysisStatus row={{status:'running',stage:'interpreting'}}/>);
  expect(screen.getByText('分析中')).toBeTruthy();
});
