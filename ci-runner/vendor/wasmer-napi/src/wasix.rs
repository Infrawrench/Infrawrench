//! Integration with the WASIX runtime's instantiation hooks.

use anyhow::{Context, Result};
use wasmer::{Imports, Instance, Memory, Module, StoreMut};
use wasmer_wasix::runtime::{InstantiationHook, InstantiationState};

use crate::{NapiInstantiationState, NapiRuntimeHooks};

/// Lets WASIX embedders register the hooks directly, e.g. through
/// `PluggableRuntime::with_instantiation_hook`.
impl InstantiationHook for NapiRuntimeHooks {
    fn additional_imports(
        &self,
        module: &Module,
        store: &mut StoreMut,
    ) -> Result<(Imports, InstantiationState)> {
        let (imports, state) = NapiRuntimeHooks::additional_imports(self, module, store)?;
        Ok((imports, InstantiationState::new(state)))
    }

    fn prepare_imports(
        &self,
        module: &Module,
        store: &mut StoreMut,
        imports: &mut Imports,
    ) -> Result<InstantiationState> {
        let state = NapiRuntimeHooks::add_imports(self, module, store, imports)?;
        Ok(InstantiationState::new(state))
    }

    fn configure_new_instance(
        &self,
        module: &Module,
        store: &mut StoreMut,
        instance: &Instance,
        imported_memory: Option<&Memory>,
        state: InstantiationState,
    ) -> Result<()> {
        let state = state
            .take::<NapiInstantiationState>()
            .context("invalid N-API instance setup state")?;
        NapiRuntimeHooks::configure_instance(self, module, store, instance, imported_memory, state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NapiCtx;
    use wasmer::{AsStoreMut, Extern, MemoryType, Pages, Store};

    #[test]
    fn prepare_imports_reuses_wasix_memory() {
        let mut store = Store::default();
        let module = Module::new(
            &store,
            r#"(module
                (import "env" "memory" (memory 1 1))
                (import "napi" "napi_get_undefined"
                    (func (param i32 i32) (result i32)))
            )"#,
        )
        .expect("module compiles");
        let memory =
            wasmer::Memory::new(&mut store, MemoryType::new(Pages(1), Some(Pages(1)), false))
                .expect("WASIX memory can be created");
        memory
            .view(&store)
            .write(32, &[1, 2, 3, 4])
            .expect("marker can be written");
        let mut imports = Imports::new();
        imports.define("env", "memory", memory);

        let hooks = NapiCtx::default().runtime_hooks();
        let _state = InstantiationHook::prepare_imports(
            &hooks,
            &module,
            &mut store.as_store_mut(),
            &mut imports,
        )
        .expect("N-API imports can be prepared");

        let Some(Extern::Memory(prepared_memory)) = imports.get_export("env", "memory") else {
            panic!("prepared imports must contain env.memory");
        };
        let mut marker = [0; 4];
        prepared_memory
            .view(&store)
            .read(32, &mut marker)
            .expect("marker can be read through prepared memory");
        assert_eq!(marker, [1, 2, 3, 4]);
        assert_eq!(
            imports
                .iter()
                .filter(|(namespace, name, _)| *namespace == "env" && *name == "memory")
                .count(),
            1
        );
    }
}
