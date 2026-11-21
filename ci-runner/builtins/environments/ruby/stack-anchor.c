/*
 * Linked into every extension env:ruby builds (configure's DLDFLAGS). A side
 * module imports __stack_pointer only if one of its functions uses the stack,
 * and Binaryen's --spill-pointers, which every module is put through
 * (build.sh), needs that import to give a function a frame to spill into.
 * This constructor keeps one byte on the stack, so the import is always
 * there, and runs once when the module is loaded.
 */
__attribute__((constructor)) static void ruby_wasix_stack_anchor(void)
{
    volatile char byte = 0;
    (void)byte;
}
