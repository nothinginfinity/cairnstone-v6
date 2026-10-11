// Test-only HomeScope builder shared by the private-realm suites.
export const sc = (acct, name, extra = {}) => ({
  account_id: `acct_${acct}`,
  tenant_id: `ten_${acct}`,
  principal_id: `prin_${acct}_${name}`,
  connection_id: `conn_${acct}_${name}`,
  provider_label: name,
  ...extra
});
