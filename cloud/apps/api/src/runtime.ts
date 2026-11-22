import {createExecutionDriver,type ExecutionOptions} from './execution.js';
import type {ApiService} from './service.js';
export function localDriver(service:ApiService,options:Omit<ExecutionOptions,'service'>={}){return createExecutionDriver({service,...options});}
