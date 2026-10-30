import {createExecutionDriver,type ExecutionOptions} from './execution.js';
import type {ApiService} from './service.js';
/** Local driver: in-process continuation queue, scripted provider available. */
export function localDriver(service:ApiService,options:Omit<ExecutionOptions,'service'>={}){return createExecutionDriver({service,...options});}
