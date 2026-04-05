use sqlx::mysql::MySqlPoolOptions;
use sqlx::{Column, Row, TypeInfo};

/// Run a SQL query against a MySQL connection string.
/// Returns rows as an array of JSON objects (column name → value).
#[tauri::command]
pub async fn mysql_query(
    connection_string: String,
    sql: String,
) -> Result<Vec<serde_json::Value>, String> {
    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&connection_string)
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
            obj.insert(col.name().to_string(), mysql_value_to_json(row, i));
        }
        result.push(serde_json::Value::Object(obj));
    }

    Ok(result)
}

/// Execute a SQL statement (INSERT/UPDATE/DELETE) with JSON-typed parameters.
/// Returns the number of rows affected.
#[tauri::command]
pub async fn mysql_execute(
    connection_string: String,
    sql: String,
    params: Vec<serde_json::Value>,
) -> Result<u64, String> {
    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&connection_string)
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

fn mysql_value_to_json(row: &sqlx::mysql::MySqlRow, i: usize) -> serde_json::Value {
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
        "BOOLEAN" | "TINYINT(1)" => { try_get!(bool); }
        "TINYINT" => { try_get!(i8); }
        "SMALLINT" => { try_get!(i16); }
        "INT" | "MEDIUMINT" => { try_get!(i32); }
        "BIGINT" => { try_get!(i64); }
        "TINYINT UNSIGNED" => { try_get!(u8); }
        "SMALLINT UNSIGNED" => { try_get!(u16); }
        "INT UNSIGNED" | "MEDIUMINT UNSIGNED" => { try_get!(u32); }
        "BIGINT UNSIGNED" => { try_get!(u64); }
        "FLOAT" => { try_get!(f32); }
        "DOUBLE" => { try_get!(f64); }
        "VARCHAR" | "TEXT" | "CHAR" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            try_get!(String);
        }
        _ => {}
    }

    // Fallback: try as String, then null
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return match v {
            Some(v) => serde_json::Value::String(v),
            None => serde_json::Value::Null,
        };
    }

    serde_json::Value::Null
}

fn bind_json_param<'a>(
    q: sqlx::query::Query<'a, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    val: &serde_json::Value,
) -> sqlx::query::Query<'a, sqlx::MySql, sqlx::mysql::MySqlArguments> {
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
