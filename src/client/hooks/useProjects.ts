import { useState, useCallback } from 'react';
import type { Project } from '@shared/types';

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);

  const setInitial = useCallback((initial: Project[]) => {
    setProjects(initial);
  }, []);

  const addProject = useCallback((project: Project) => {
    setProjects(prev => [...prev, project].sort((a, b) => a.name.localeCompare(b.name)));
  }, []);

  const updateProject = useCallback((project: Project) => {
    setProjects(prev => prev.map(p => p.id === project.id ? project : p));
  }, []);

  const removeProject = useCallback((id: string) => {
    setProjects(prev => prev.filter(p => p.id !== id));
  }, []);

  return { projects, setInitial, addProject, updateProject, removeProject };
}
