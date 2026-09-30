import { signal, computed, Injector, InjectionToken } from '@angular/core';
import { of, map, filter } from 'rxjs';

// Test 1: Angular Signals
const count = signal(10);
const double = computed(() => count() * 2);

if (count() !== 10 || double() !== 20) {
  throw new Error(`Signal mismatch: expected 10 and 20, got ${count()} and ${double()}`);
}

count.set(25);
if (count() !== 25 || double() !== 50) {
  throw new Error(`Signal mismatch after update: expected 25 and 50, got ${count()} and ${double()}`);
}

// Test 2: Angular Dependency Injection
const APP_CONFIG = new InjectionToken('app.config');
const injector = Injector.create({
  providers: [
    { provide: APP_CONFIG, useValue: { apiEndpoint: 'https://api.malia.dev', port: 8080 } }
  ]
});

const config = injector.get(APP_CONFIG);
if (!config || config.port !== 8080) {
  throw new Error(`Injector mismatch: expected port 8080, got ${config?.port}`);
}

// Test 3: RxJS Streams
let streamResult = [];
of(1, 2, 3, 4, 5)
  .pipe(
    filter(x => x % 2 === 1),
    map(x => x * 10)
  )
  .subscribe(val => streamResult.push(val));

if (JSON.stringify(streamResult) !== JSON.stringify([10, 30, 50])) {
  throw new Error(`RxJS mismatch: expected [10, 30, 50], got ${JSON.stringify(streamResult)}`);
}

console.log('Angular Signals & DI + RxJS: Verified successfully.');
console.log('ANGULAR_PASS');
