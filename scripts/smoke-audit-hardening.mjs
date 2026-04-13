const targets = [
  {
    name: 'staging',
    url: process.env.SUPABASE_STAGING_URL,
    key: process.env.SUPABASE_STAGING_SERVICE_ROLE_KEY,
  },
  {
    name: 'production',
    url: process.env.SUPABASE_PRODUCTION_URL,
    key: process.env.SUPABASE_PRODUCTION_SERVICE_ROLE_KEY,
  },
];

const partiallyConfigured = targets.filter(
  (target) => Boolean(target.url) !== Boolean(target.key),
);

if (partiallyConfigured.length > 0) {
  console.error(
    `Smoke test configuration is incomplete for: ${partiallyConfigured.map((t) => t.name).join(', ')}`,
  );
  process.exit(1);
}

const configuredTargets = targets.filter((target) => target.url && target.key);

if (configuredTargets.length === 0) {
  console.log('No Supabase smoke-test environments configured. Skipping.');
  process.exit(0);
}

for (const target of configuredTargets) {
  const response = await fetch(`${target.url}/rest/v1/rpc/audit_rls_smoke_check`, {
    method: 'POST',
    headers: {
      apikey: target.key,
      Authorization: `Bearer ${target.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Smoke test failed for ${target.name}: ${response.status} ${errorText}`);
    process.exit(1);
  }

  const result = await response.json();
  const failedChecks = Object.entries(result).filter(([, passed]) => passed !== true);
  if (failedChecks.length > 0) {
    console.error(
      `Smoke test failed for ${target.name}; missing checks: ${failedChecks
        .map(([name]) => name)
        .join(', ')}`,
    );
    process.exit(1);
  }

  console.log(`Security hardening smoke test passed for ${target.name}.`);
}
