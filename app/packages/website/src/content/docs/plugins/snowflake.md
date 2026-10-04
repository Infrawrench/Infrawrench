---
title: Snowflake
description: Track Snowflake spend by service and warehouse, query cost by tag, user and role, and manage warehouses, databases, resource monitors, users, roles, tasks, pipes and dynamic tables.
sidebar_order: 19
---

## What you can manage

- **Warehouses**: suspend, resume, resize (X-Small to 6X-Large), change auto-suspend and auto-resume, multi-cluster limits, scaling policy and query acceleration, assign a resource monitor, create and drop. Warehouses can go on [sleep/wake schedules](../features/sleep-schedules.md).
- **Databases and schemas**: storage and Fail-safe bytes, Time Travel retention and comment (editable), create (permanent or transient; standard or managed-access schemas) and drop.
- **Resource monitors**: create one with a credit quota, reset interval and notify / suspend / suspend-immediately thresholds, edit any of them, assign it to a warehouse or make it the account monitor.
- **Users**: how each signs in (password, key pair, MFA), last login, default role and warehouse (editable); disable and re-enable. Users show up in the [access review](../features/access-review.md).
- **Roles**: how many users and roles hold each one; create, comment, drop.
- **Tasks**: suspend, resume, run now, change the schedule.
- **Pipes**: execution state and pending files, pause, resume, refresh.
- **Dynamic tables**: target lag (editable), scheduling state, rows and size; suspend, resume, refresh now.
- **SQL editor** on every resource, through Snowflake's SQL API (see [SQL editor](../features/sql-editor.md)).

## Credentials

You need four things; the form explains each.

1. **Account**: your account identifier (`orgname-accountname`) or any URL for the account. The Snowsight address (`app.snowflake.com/<org>/<account>/…`) and the account URL (`<org>-<account>.snowflakecomputing.com`) both work, as do legacy account locators (`xy12345.us-east-2.aws`) and PrivateLink URLs.
2. **User**: the Snowflake user to connect as. A dedicated service user is best.
3. **Private key or access token**: either the user's **unencrypted** RSA private key in PEM form, or a programmatic access token.
4. **Role** and **Warehouse**: once the first three are filled in, both become pickers listing the roles granted to the user and the warehouses the role can see. Leave either on the default to use the user's own default.

A minimal key-pair setup, run as an administrator:

```sql
CREATE ROLE INFRAWRENCH;
GRANT DATABASE ROLE SNOWFLAKE.USAGE_VIEWER TO ROLE INFRAWRENCH;
GRANT USAGE ON WAREHOUSE METADATA_WH TO ROLE INFRAWRENCH;
CREATE USER INFRAWRENCH TYPE = SERVICE DEFAULT_ROLE = INFRAWRENCH
  RSA_PUBLIC_KEY = 'MIIBIjANBgkqh...';
GRANT ROLE INFRAWRENCH TO USER INFRAWRENCH;
```

Generate the key pair with `openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out rsa_key.p8` and `openssl rsa -in rsa_key.p8 -pubout`. Encrypted keys are not accepted; Infrawrench stores the key encrypted on its side.

**Programmatic access tokens** need the user to be covered by a network policy, unless an authentication policy sets `NETWORK_POLICY_EVALUATION = ENFORCED_NOT_REQUIRED`. Tokens expire (15 days by default, at most a year); update it under **Edit credentials**.

To manage objects (resize warehouses, create monitors, disable users), grant the role the matching privileges: `MODIFY` and `OPERATE` on warehouses, ownership or `MANAGE GRANTS` for users and roles. Creating and assigning resource monitors needs `ACCOUNTADMIN`.

<insert [Snowflake add-account form with the account, user and key fields filled in, and the Role and Warehouse pickers open] here>

## Costs

Snowflake spend comes from one of two sources, chosen per account each time costs are collected:

- **Billed**, when the role can read `SNOWFLAKE.ORGANIZATION_USAGE` (ORGADMIN, or GLOBALORGADMIN in the organization account): the amounts on your bill in your contract currency from `USAGE_IN_CURRENCY_DAILY`, with rebates and support credits recorded as credits and adjustments as adjustments. This data is up to 72 hours behind and can change until the month closes. Reseller customers cannot read it.
- **Estimated** otherwise: credits from `ACCOUNT_USAGE.METERING_DAILY_HISTORY` times the **Price per Credit** on the connection, storage bytes times the **Storage Price per TB-Month**, and data transfer times the **Data Transfer Price per TB** if you enter one. Cloud services are charged net of Snowflake's 10% daily adjustment. Edit the prices under **Edit credentials** to match your contract.

Either way, spend is grouped by service: warehouse compute, cloud services, serverless features (tasks, Snowpipe, clustering, materialized views and the rest), storage, data transfer and AI services. Warehouse compute is split by warehouse, in proportion to each warehouse's credits that day, so it shows up per warehouse in [cost reports](../features/cost-reports.md). Every row carries a `costBasis` tag (`billed` or `estimated`) and a `serviceType` tag with Snowflake's own service type, so you can filter on either. Because the basis is only known per account, Snowflake accounts are labelled as estimated in the Costs panel.

The account page shows month-to-date spend by service and by warehouse, and the remaining **capacity balance** when the role can read organization usage. The balance also feeds [credit burndown](../features/credit-burndown.md).

## Query cost attribution

The account page breaks the last 30 days of query credits down by **query tag**, **user**, **role** and **warehouse**, from `ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY` (roles joined from `QUERY_HISTORY`). Set `QUERY_TAG` in your sessions or connection strings to group cost by workload, team or dbt model. Attribution only covers query execution: idle warehouse time, queries of about 100 ms or less, cloud services and serverless features are not included, so it adds up to less than the warehouse bill. Infrawrench tags its own queries `infrawrench`.

<insert [Snowflake account detail page showing spend this month by service and the query cost attribution tables] here>

## Recommendations

Warehouses that waste credits are flagged on the warehouse and account pages:

- **Auto-suspend off**: the warehouse bills until someone suspends it. A running warehouse like this also appears under **Potential savings**.
- **Auto-suspend longer than 10 minutes**: every idle stretch is billed at the full rate.
- **Try one size smaller**: Medium or larger, averaging under 25% of its capacity while active over 14 days with no queueing.
- **Queries are queueing**: a larger size or more clusters would cut waits.
- **No use in 14 days**: a candidate to drop.

Size and auto-suspend recommendations come with a one-click fix.

## Metrics

| Resource  | Metrics tab                                                                                  |
| --------- | -------------------------------------------------------------------------------------------- |
| Account   | Credits per day by service, database / stage / Fail-safe storage per day                     |
| Warehouse | Credits and cloud services credits per hour; running, queued and blocked query load per hour |
| Database  | Storage and Fail-safe bytes per day                                                          |

Resource monitors with a credit quota appear on the [quota radar](../features/quota-radar.md).

## Tips & limits

- **Listing never wakes a warehouse.** Resources are read with `SHOW` commands, which Snowflake answers without compute. Costs, metrics, recommendations and attribution do query `ACCOUNT_USAGE`, which needs the connection's warehouse; an X-Small with a 60 second auto-suspend is plenty. Those reads are cached for 30 minutes, so a pinned warehouse's chart does not keep the warehouse running.
- `ACCOUNT_USAGE` views lag up to three hours (query attribution up to eight), so the newest data on charts is that old.
- `SHOW USERS` needs ownership of the users or `MANAGE GRANTS`; without it the user list is empty.
- A role sees only the warehouses, databases and monitors it has privileges on.
- The SQL editor runs one statement at a time.
