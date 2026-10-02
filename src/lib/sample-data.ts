/**
 * "Try with sample data": a small dirty orders file plus a fixed template whose
 * rules clean it. The template is seeded by migration 003 (same id and rules,
 * checked by sample-data.test.ts), so a sample run takes suggest-transforms'
 * template path and never calls Bedrock.
 */
export const DEMO_TEMPLATE_ID = "c1ea0000-5a3d-4e00-8000-000000000001";
export const SAMPLE_FILENAME = "sample-orders.csv";

export const DEMO_TEMPLATE_RULES = [
  { rule_type: "trim_whitespace", column_name: null, parameters: {}, ai_reasoning: "Several customer and status values have leading or trailing spaces." },
  { rule_type: "deduplicate", column_name: null, parameters: {}, ai_reasoning: "Orders 1004 and 1011 appear twice with identical values." },
  { rule_type: "fill_nulls", column_name: "status", parameters: { strategy: "value", value: "unknown" }, ai_reasoning: "Two orders have no status." },
  { rule_type: "normalize", column_name: "status", parameters: {}, ai_reasoning: "Status mixes SHIPPED, shipped and Shipped." },
  { rule_type: "type_cast", column_name: "amount", parameters: { target_type: "float" }, ai_reasoning: "Amounts carry dollar signs and thousands separators, which blocks numeric totals." },
  { rule_type: "normalize", column_name: "order_date", parameters: {}, ai_reasoning: "Dates mix ISO, US and slash formats." },
] as const;

export const SAMPLE_CSV = `order_id,customer,email,amount,status,order_date
1001,  Alice Johnson ,alice@example.com,$120.50,SHIPPED,2024-03-01
1002,Bob Smith,bob@example.com,89.99,shipped,03/02/2024
1003, Carol White,carol@example.com,"$1,045.00",Pending,2024/03/03
1004,Dan Brown ,dan@example.com,$15,delivered,2024-03-04
1004,Dan Brown ,dan@example.com,$15,delivered,2024-03-04
1005,Eve Davis,eve@example.com,230.00,,2024-03-05
1006,Frank Moore,frank@example.com,$64.20,Shipped ,03/06/2024
1007,Grace Lee,grace@example.com,12.00,PENDING,2024-03-07
1008, Henry Clark,henry@example.com,"$2,300.75",delivered,2024/03/08
1009,Ivy Lewis,ivy@example.com,$48.00,cancelled,2024-03-09
1010,Jack Hall,jack@example.com,77.10,,03/10/2024
1011,Kara Young,kara@example.com,$5.99,shipped,2024-03-11
1011,Kara Young,kara@example.com,$5.99,shipped,2024-03-11
1012,Liam King ,liam@example.com,$310.00,Delivered,2024-03-12
`;
