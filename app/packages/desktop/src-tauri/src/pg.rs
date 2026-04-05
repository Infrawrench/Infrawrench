use sqlx::postgres::PgPoolOptions;
use sqlx::{Column, Row, TypeInfo};

/// Execute a SQL statement (INSERT/UPDATE/DELETE) with JSON-typed parameters.
/// Returns the number of rows affected.
#[tauri::command]
pub async fn pg_execute(
    connection_string: String,
    sql: String,
    params: Vec<serde_json::Value>,
) -> Result<u64, String> {
    let cs = sanitize_url(&connection_string);
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&cs)
        .await
        .map_err(|e| e.to_string())?;

    let mut q = sqlx::query(&sql);
    for p in &params {
        q = bind_json_param(q, p);
    }
    let result = q.execute(&pool).await.map_err(|e| e.to_string())?;
    pool.close().await;
    Ok(result.rows_affected())
}

fn bind_json_param<'a>(
    q: sqlx::query::Query<'a, sqlx::Postgres, sqlx::postgres::PgArguments>,
    val: &serde_json::Value,
) -> sqlx::query::Query<'a, sqlx::Postgres, sqlx::postgres::PgArguments> {
    match val {
        serde_json::Value::Null => q.bind(Option::<String>::None),
        serde_json::Value::Bool(b) => q.bind(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() { q.bind(i) }
            else if let Some(f) = n.as_f64() { q.bind(f) }
            else { q.bind(n.to_string()) }
        }
        serde_json::Value::String(s) => q.bind(s.clone()),
        other => q.bind(other.to_string()),
    }
}

/// Run a SQL query against a PostgreSQL connection string.
/// Returns rows as an array of JSON objects (column name → value).
#[tauri::command]
pub async fn pg_query(
    connection_string: String,
    sql: String,
) -> Result<Vec<serde_json::Value>, String> {
    // Strip parameters sqlx doesn't understand (e.g. Neon's channel_binding)
    let cs = sanitize_url(&connection_string);

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&cs)
        .await
        .map_err(|e| e.to_string())?;

    let rows = sqlx::query(&sql)
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;

    pool.close().await;

    let mut result = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut obj = serde_json::Map::new();
        for (i, col) in row.columns().iter().enumerate() {
            let val = pg_value_to_json(row, i);
            obj.insert(col.name().to_string(), val);
        }
        result.push(serde_json::Value::Object(obj));
    }

    Ok(result)
}

fn pg_value_to_json(row: &sqlx::postgres::PgRow, i: usize) -> serde_json::Value {
    let type_name = row.columns()[i].type_info().name();

    macro_rules! try_get {
        ($t:ty) => {
            if let Ok(v) = row.try_get::<Option<$t>, _>(i) {
                return match v {
                    Some(v) => serde_json::json!(v),
                    None => serde_json::Value::Null,
                };
            }
        };
    }

    match type_name {
        "BOOL" => { try_get!(bool); }
        "INT2" => { try_get!(i16); }
        "INT4" => { try_get!(i32); }
        "INT8" => { try_get!(i64); }
        "FLOAT4" => { try_get!(f32); }
        "FLOAT8" => { try_get!(f64); }
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CHAR" => { try_get!(String); }
        "UUID" => {
            if let Ok(v) = row.try_get::<Option<sqlx::types::Uuid>, _>(i) {
                return match v {
                    Some(v) => serde_json::Value::String(v.to_string()),
                    None => serde_json::Value::Null,
                };
            }
        }
        _ => {}
    }

    // Fallback: try as String, then give up and return null
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return match v {
            Some(v) => serde_json::Value::String(v),
            None => serde_json::Value::Null,
        };
    }

    serde_json::Value::Null
}

fn sanitize_url(cs: &str) -> String {
    match url::Url::parse(cs) {
        Ok(mut u) => {
            let pairs: Vec<(String, String)> = u
                .query_pairs()
                .filter(|(k, _)| k != "channel_binding")
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            if pairs.is_empty() {
                u.set_query(None);
            } else {
                u.set_query(Some(
                    &pairs
                        .iter()
                        .map(|(k, v)| format!("{}={}", k, v))
                        .collect::<Vec<_>>()
                        .join("&"),
                ));
            }
            u.to_string()
        }
        Err(_) => cs.to_string(),
    }
}
