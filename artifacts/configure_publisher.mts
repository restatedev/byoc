#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const role = "restate-byoc-artifacts-upload";
function aws(...args: string[]) {
  return JSON.parse(
    execFileSync("aws", [...args, "--output", "json", "--no-cli-pager"], {
      encoding: "utf8",
    }) || "null",
  );
}
if (aws("sts", "get-caller-identity").Account !== "654654156625")
  throw new Error("Expected the production AWS account 654654156625");
const attached = aws("iam", "list-attached-role-policies", "--role-name", role);
const inline = aws("iam", "list-role-policies", "--role-name", role);
if (
  attached.AttachedPolicies.length ||
  inline.PolicyNames.some((name: string) => name !== "upload")
)
  throw new Error(
    "Unexpected publisher policies; review them before proceeding",
  );
const policy = fileURLToPath(new URL("publisher-policy.json", import.meta.url));
const trust = fileURLToPath(
  new URL("publisher-trust-policy.json", import.meta.url),
);
console.log(
  JSON.stringify(
    {
      role,
      policy: JSON.parse(readFileSync(policy, "utf8")),
      trust: JSON.parse(readFileSync(trust, "utf8")),
    },
    null,
    2,
  ),
);
if (process.argv.slice(2).includes("--apply")) {
  const environmentPath =
    "repos/restatedev/byoc/environments/byoc-artifact-publish";
  const environment = JSON.parse(
    execFileSync("gh", ["api", environmentPath], { encoding: "utf8" }),
  );
  const branches = JSON.parse(
    execFileSync(
      "gh",
      ["api", `${environmentPath}/deployment-branch-policies`],
      { encoding: "utf8" },
    ),
  ).branch_policies;
  const rules = branches
    .map((rule: { type: string; name: string }) => `${rule.type}:${rule.name}`)
    .sort();
  if (
    environment.deployment_branch_policy?.protected_branches !== false ||
    environment.deployment_branch_policy?.custom_branch_policies !== true ||
    JSON.stringify(rules) !== JSON.stringify(["branch:main", "tag:v*"])
  )
    throw new Error(
      "The publishing environment must allow only main and v* tags",
    );
  aws(
    "iam",
    "put-role-policy",
    "--role-name",
    role,
    "--policy-name",
    "upload",
    "--policy-document",
    `file://${policy}`,
  );
  aws(
    "iam",
    "update-assume-role-policy",
    "--role-name",
    role,
    "--policy-document",
    `file://${trust}`,
  );
  console.log("Publisher policy and environment trust applied");
} else {
  console.log("Dry run; pass --apply to change the existing role");
}
