/**
 * Unit tests for evaluateAnswer (simple examples).
 * Replace test runner imports with your project's test setup (jest/mocha).
 */

import { evaluateAnswer } from "../src/evaluator/scoring";

async function runTests() {
  // Case 1: answer clearly on-topic but topic name omitted -> full marks
  const res1 = await evaluateAnswer(
    "The process uses distributed hash tables and consistent hashing to shard keys across nodes",
    ["consistent hashing", "DHT", "sharding"],
    10,
    0.5
  );
  console.log("Test 1", res1);
  // Expect score == 10

  // Case 2: answer off-topic -> low marks
  const res2 = await evaluateAnswer(
    "I like pancakes",
    ["consistent hashing", "DHT", "sharding"],
    10,
    0.5
  );
  console.log("Test 2", res2);
  // Expect score small (likely 0)

  // Case 3: partially related answer -> partial marks
  const res3 = await evaluateAnswer(
    "Hashing distributes keys across nodes; replication can be used for fault tolerance",
    ["consistent hashing", "DHT", "sharding"],
    10,
    0.6
  );
  console.log("Test 3", res3);
  // Expect score between 1 and 9
}

runTests().catch(console.error);
