# Demo Database Seed Design

## Goal

Provide one MySQL 8.x SQL script that initializes realistic structured data for the project's database agent. The script must be directly executable, deterministic, and safe to rerun in the dedicated `deep_search` demo database.

## Tables And Data Volume

1. `warehouses`: 5 warehouses in different Chinese cities.
2. `products`: 4 products matching the manuals stored in RAGFlow.
3. `inventory`: 20 rows, one row for every product and warehouse pair.
4. `sales_records`: 200 deterministic sales transactions distributed across products, warehouses, dates, regions, and sales channels.

## Relationships

- `inventory.product_id` references `products.product_id`.
- `inventory.warehouse_id` references `warehouses.warehouse_id`.
- `sales_records.product_id` references `products.product_id`.
- `sales_records.warehouse_id` references `warehouses.warehouse_id`.
- `inventory` has a unique constraint on `(product_id, warehouse_id)`.

## Product Scope

The four products are:

- Huawei Qingyun W585X desktop computer
- Huawei B3-243H monitor
- RS-12 digital multimeter
- Xunrao gateway and Xiaomi device communication integration package

RAGFlow remains responsible for manuals, usage instructions, safety guidance, troubleshooting, and configuration procedures. MySQL contains commercial and operational facts such as price, stock, warehouse, and sales.

## Script Behavior

- Use UTF-8 (`utf8mb4`) and InnoDB.
- Drop the four demo tables in dependency order, then recreate them. This makes every run produce the same clean data set.
- Insert fixed warehouse and product rows.
- Generate all 20 inventory rows from the product/warehouse combinations.
- Generate exactly 200 sales rows using deterministic SQL expressions, so no external generator is needed.
- Create foreign keys and indexes for product, warehouse, date, category, SKU, and stock queries.
- End with row-count and referential-integrity checks.

## Expected Queries

The data should support demonstrations such as:

- Current inventory and low-stock products by warehouse.
- Sales quantity and revenue by product, warehouse, date range, region, or channel.
- Best-selling products and inventory turnover comparisons.
- Combined questions where MySQL supplies stock/sales facts and RAGFlow supplies product instructions.

## Delivery And Verification

The SQL file will live under `database/`. It will be executed against the configured local MySQL database, then verified for exact row counts (`5`, `4`, `20`, `200`), valid foreign keys, and representative aggregate queries. The one-click command will use the existing `.env` connection settings without printing credentials.
