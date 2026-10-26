import { assertEquals } from "jsr:@std/assert@1";
import { dueNow } from "./shopPricing.ts";

Deno.test("percent deposit is that share of the total, rounded to the cent", () => {
  assertEquals(dueNow(1039200, { mode: "percent", value: 10 }, false), 103920);
  assertEquals(dueNow(1001, { mode: "percent", value: 15 }, false), 150);
});
Deno.test("flat deposit is dollars, capped at the total", () => {
  assertEquals(dueNow(1039200, { mode: "flat", value: 500 }, false), 50000);
  assertEquals(dueNow(30000, { mode: "flat", value: 500 }, false), 30000);
});
Deno.test("full mode, or a buyer paying in full, owes the total", () => {
  assertEquals(dueNow(1039200, { mode: "full", value: 0 }, false), 1039200);
  assertEquals(dueNow(1039200, { mode: "percent", value: 10 }, true), 1039200);
});
Deno.test("out-of-range values cannot produce a negative or oversized charge", () => {
  assertEquals(dueNow(1000, { mode: "percent", value: 250 }, false), 1000);
  assertEquals(dueNow(1000, { mode: "flat", value: -5 }, false), 0);
});
