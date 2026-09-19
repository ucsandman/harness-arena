import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import type { deviceCodes, devices, sessions, users } from './identity.js';
import type { agents, harnessVersions, harnesses, repositories, tasks } from './catalog.js';
import type { artifacts, battleRuns, battles, evaluations, events, metrics } from './battles.js';
import type { ratingEvents, ratings } from './ratings.js';

export * from './enums.js';
export * from './identity.js';
export * from './catalog.js';
export * from './battles.js';
export * from './ratings.js';

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;
export type Session = InferSelectModel<typeof sessions>;
export type NewSession = InferInsertModel<typeof sessions>;
export type DeviceCode = InferSelectModel<typeof deviceCodes>;
export type NewDeviceCode = InferInsertModel<typeof deviceCodes>;
export type Device = InferSelectModel<typeof devices>;
export type NewDevice = InferInsertModel<typeof devices>;

export type Agent = InferSelectModel<typeof agents>;
export type NewAgent = InferInsertModel<typeof agents>;
export type Harness = InferSelectModel<typeof harnesses>;
export type NewHarness = InferInsertModel<typeof harnesses>;
export type HarnessVersion = InferSelectModel<typeof harnessVersions>;
export type NewHarnessVersion = InferInsertModel<typeof harnessVersions>;
export type Repository = InferSelectModel<typeof repositories>;
export type NewRepository = InferInsertModel<typeof repositories>;
export type Task = InferSelectModel<typeof tasks>;
export type NewTask = InferInsertModel<typeof tasks>;

export type Battle = InferSelectModel<typeof battles>;
export type NewBattle = InferInsertModel<typeof battles>;
export type BattleRun = InferSelectModel<typeof battleRuns>;
export type NewBattleRun = InferInsertModel<typeof battleRuns>;
export type EventRow = InferSelectModel<typeof events>;
export type NewEventRow = InferInsertModel<typeof events>;
export type MetricRow = InferSelectModel<typeof metrics>;
export type NewMetricRow = InferInsertModel<typeof metrics>;
export type Evaluation = InferSelectModel<typeof evaluations>;
export type NewEvaluation = InferInsertModel<typeof evaluations>;
export type Artifact = InferSelectModel<typeof artifacts>;
export type NewArtifact = InferInsertModel<typeof artifacts>;

export type RatingRow = InferSelectModel<typeof ratings>;
export type NewRatingRow = InferInsertModel<typeof ratings>;
export type RatingEventRow = InferSelectModel<typeof ratingEvents>;
export type NewRatingEventRow = InferInsertModel<typeof ratingEvents>;
