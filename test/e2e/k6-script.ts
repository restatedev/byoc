import http from "k6/http";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.2/index.js";

export const options = {
  scenarios: {
    ramping_rps: {
      executor: "ramping-arrival-rate",
      startRate: 10,
      stages: [
        { duration: "30s", target: 100 },
        { duration: "60m", target: 100 },
      ],
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<2000"],
    http_req_failed: ["rate<0.01"],
  },
};

// Generate random 32-character alphanumeric string
function generateRandomKey(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export default function (): void {
  const ingressUrl = __ENV.RESTATE_INGRESS_URL;
  if (!ingressUrl) {
    throw new Error("RESTATE_INGRESS_URL environment variable is required");
  }
  const url = `${ingressUrl}/Echo/echo`;

  const params = {
    headers: {
      "idempotency-key": generateRandomKey(),
      "Content-Type": "application/json",
    },
    timeout: "60s",
  };

  http.post(url, JSON.stringify("ping"), params);
}

export function handleSummary(data: object): Record<string, string> {
  // this just gets dumped in the CWD
  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    "load-test-summary.json": JSON.stringify(data, null, 2),
  };
}
