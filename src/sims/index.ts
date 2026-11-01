import type { ComponentType } from 'react';
import { sims as g1 } from './g1';
import { sims as g2 } from './g2';
import { sims as g3 } from './g3';
import { sims as g4 } from './g4';
import { sims as g5 } from './g5';

export const SIMS: Record<number, ComponentType> = { ...g1, ...g2, ...g3, ...g4, ...g5 };
