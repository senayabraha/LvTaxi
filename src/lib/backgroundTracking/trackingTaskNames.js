// Background TaskManager task identifiers for the automatic tracking system.
//
// These tasks are defined at top-level module scope in passiveLocationTask.js /
// activeLocationTask.js (a hard Expo requirement: TaskManager.defineTask must run
// before the OS can deliver a background execution). They are kept in their own
// tiny module so the service layer can reference the names WITHOUT importing the
// task files (which would create a circular dependency).

export const LVTAXI_PASSIVE_LOCATION_TASK = 'LVTAXI_PASSIVE_LOCATION_TASK';
export const LVTAXI_ACTIVE_LOCATION_TASK = 'LVTAXI_ACTIVE_LOCATION_TASK';
