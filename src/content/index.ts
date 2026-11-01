import type { GroupId, Lesson } from '../types';
import { lessons as g1 } from './g1';
import { lessons as g2 } from './g2';
import { lessons as g3 } from './g3';
import { lessons as g4 } from './g4';
import { lessons as g5 } from './g5';

export const LESSONS: Lesson[] = [...g1, ...g2, ...g3, ...g4, ...g5].sort((a, b) => a.id - b.id);
export const byId = (id: number) => LESSONS.find((l) => l.id === id);

export const GROUPS: { id: GroupId; title: string; blurb: string }[] = [
  { id: 'foundations', title: 'Foundations', blurb: 'Request path, streaming, KV memory, paging, attention kernels.' },
  { id: 'scheduling', title: 'Scheduling & latency', blurb: 'Batching, chunked prefill, prefix routing, token gaps, speculation.' },
  { id: 'gpu', title: 'Models & GPU performance', blurb: 'Quantization, hardware choice, profiling, utilization, kernels.' },
  { id: 'production', title: 'Production engineering', blurb: 'Observability, tail latency, engine benchmarks, rollouts, autoscaling.' },
  { id: 'systems', title: 'Systems design', blurb: 'Multi-tenancy, disaggregation, MoE parallelism, cost, capacity.' },
];
