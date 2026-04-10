// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useJobs } from '../../client/hooks/useJobs';
import { makeJob } from './factories';

describe('useJobs', () => {
  it('starts with an empty job list', () => {
    const { result } = renderHook(() => useJobs());
    expect(result.current.jobs).toEqual([]);
  });

  it('sets initial jobs', () => {
    const { result } = renderHook(() => useJobs());
    const jobs = [makeJob({ id: 'j1' }), makeJob({ id: 'j2' })];
    act(() => result.current.setInitial(jobs));
    expect(result.current.jobs).toEqual(jobs);
  });

  it('adds a new job at the front', () => {
    const { result } = renderHook(() => useJobs());
    act(() => result.current.setInitial([makeJob({ id: 'j1' })]));
    act(() => result.current.addJob(makeJob({ id: 'j2' })));
    expect(result.current.jobs[0].id).toBe('j2');
    expect(result.current.jobs).toHaveLength(2);
  });

  it('does not duplicate when adding a job that already exists', () => {
    const { result } = renderHook(() => useJobs());
    const job = makeJob({ id: 'j1' });
    act(() => result.current.setInitial([job]));
    act(() => result.current.addJob(job));
    expect(result.current.jobs).toHaveLength(1);
  });

  it('updates an existing job in place', () => {
    const { result } = renderHook(() => useJobs());
    act(() => result.current.setInitial([makeJob({ id: 'j1', title: 'Original' })]));
    act(() => result.current.updateJob(makeJob({ id: 'j1', title: 'Updated' })));
    expect(result.current.jobs).toHaveLength(1);
    expect(result.current.jobs[0].title).toBe('Updated');
  });

  it('upserts a job that does not exist via updateJob', () => {
    const { result } = renderHook(() => useJobs());
    act(() => result.current.setInitial([]));
    act(() => result.current.updateJob(makeJob({ id: 'new-job' })));
    expect(result.current.jobs).toHaveLength(1);
    expect(result.current.jobs[0].id).toBe('new-job');
  });
});
