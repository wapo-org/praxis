/** Thrown by the worker's turn store when `turns.commit` rejects the index fence; the route answers 409. */
export class TurnIndexConflict extends Error {
 constructor() {
  super('Turn index was already committed or moved on');
  this.name = 'TurnIndexConflict';
 }
}
