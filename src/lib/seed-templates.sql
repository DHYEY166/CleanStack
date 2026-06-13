-- Demo template seeds — run once after Aurora is provisioned
-- Uses a fixed system author_id for public templates

INSERT INTO pipeline_templates (name, description, category, author_id, is_public, use_count, transform_rules, sample_input_schema)
VALUES

(
  'HubSpot CRM Cleaner',
  'Standardizes contact exports from HubSpot: deduplicates by email, strips whitespace, coerces phone to string, fills missing country.',
  'CRM',
  'system',
  true,
  142,
  '[
    {"rule_type":"trim_whitespace","column_name":"email","parameters":{},"ai_reasoning":"Email fields from form inputs often carry leading/trailing spaces that break matching."},
    {"rule_type":"drop_nulls","column_name":"email","parameters":{},"ai_reasoning":"Contacts without email are unusable for CRM outreach and skew deliverability metrics."},
    {"rule_type":"deduplicate","column_name":"email","parameters":{},"ai_reasoning":"Duplicate emails create redundant contacts and inflate list size."},
    {"rule_type":"type_cast","column_name":"phone","parameters":{"target_type":"str"},"ai_reasoning":"Phone numbers must be strings to preserve leading zeros and formatting."},
    {"rule_type":"fill_nulls","column_name":"country","parameters":{"value":"US"},"ai_reasoning":"Default missing country to US for domestic campaign segmentation."}
  ]'::jsonb,
  '{"email":"str","first_name":"str","last_name":"str","phone":"str","company":"str","country":"str","lifecycle_stage":"str"}'::jsonb
),

(
  'E-commerce Orders Normalizer',
  'Cleans order exports from Shopify/WooCommerce: numeric totals, datetime parsing, deduplication by order ID, filters cancelled orders.',
  'E-commerce',
  'system',
  98,
  '[
    {"rule_type":"type_cast","column_name":"order_total","parameters":{"target_type":"float"},"ai_reasoning":"Order totals exported as strings must be numeric for revenue aggregation."},
    {"rule_type":"type_cast","column_name":"order_date","parameters":{"target_type":"datetime"},"ai_reasoning":"Consistent datetime format is required for trend analysis and cohort reporting."},
    {"rule_type":"drop_nulls","column_name":"customer_id","parameters":{},"ai_reasoning":"Orders without customer IDs cannot be attributed and corrupt LTV calculations."},
    {"rule_type":"deduplicate","column_name":"order_id","parameters":{},"ai_reasoning":"Duplicate order IDs from webhook retries cause double-counting in revenue reports."},
    {"rule_type":"filter","column_name":"status","parameters":{"operator":"neq","value":"cancelled"},"ai_reasoning":"Cancelled orders should be excluded from completed revenue analysis."}
  ]'::jsonb,
  '{"order_id":"str","customer_id":"str","order_date":"str","order_total":"str","status":"str","product_count":"str","shipping_country":"str"}'::jsonb
),

(
  'Finance Report Normalizer',
  'Standardizes bank statement and expense report exports: numeric amounts, datetime transactions, fills uncategorized entries.',
  'Finance',
  'system',
  76,
  '[
    {"rule_type":"type_cast","column_name":"amount","parameters":{"target_type":"float"},"ai_reasoning":"Financial amounts must be numeric for sum, average, and variance calculations."},
    {"rule_type":"type_cast","column_name":"date","parameters":{"target_type":"datetime"},"ai_reasoning":"Transaction dates need ISO format for period-over-period comparison."},
    {"rule_type":"fill_nulls","column_name":"category","parameters":{"value":"Uncategorized"},"ai_reasoning":"Missing categories break budget reports — a default keeps rows usable."},
    {"rule_type":"trim_whitespace","column_name":"description","parameters":{},"ai_reasoning":"Bank export descriptions have irregular whitespace from legacy systems."},
    {"rule_type":"filter","column_name":"amount","parameters":{"operator":"neq","value":"0"},"ai_reasoning":"Zero-amount transactions are typically system-generated artifacts with no business value."}
  ]'::jsonb,
  '{"date":"str","description":"str","amount":"str","category":"str","account":"str","currency":"str"}'::jsonb
),

(
  'HR Roster Cleaner',
  'Prepares employee roster exports for HRIS import: enforces employee ID, deduplicates, normalizes salary, fills missing manager.',
  'HR',
  'system',
  54,
  '[
    {"rule_type":"drop_nulls","column_name":"employee_id","parameters":{},"ai_reasoning":"Records without employee IDs cannot be processed by any HRIS system."},
    {"rule_type":"deduplicate","column_name":"employee_id","parameters":{},"ai_reasoning":"Duplicate employee records corrupt headcount metrics and payroll runs."},
    {"rule_type":"type_cast","column_name":"salary","parameters":{"target_type":"float"},"ai_reasoning":"Salary data exported as formatted strings must be numeric for compensation analytics."},
    {"rule_type":"trim_whitespace","column_name":"department","parameters":{},"ai_reasoning":"Department names entered via form often have inconsistent spacing that breaks grouping."},
    {"rule_type":"fill_nulls","column_name":"manager_id","parameters":{"value":"NONE"},"ai_reasoning":"C-suite executives and contractors may have no direct manager — NONE is a valid sentinel."}
  ]'::jsonb,
  '{"employee_id":"str","first_name":"str","last_name":"str","department":"str","salary":"str","manager_id":"str","hire_date":"str","status":"str"}'::jsonb
);
