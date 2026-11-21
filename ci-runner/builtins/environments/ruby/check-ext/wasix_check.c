/*
 * The extension build.sh builds with the recipe in README.md ("Ruby"), as a
 * gem's would be, so builtins/test.sh can load it in a job with a plain
 * `require`. Each method exercises something a side module needs from the
 * interpreter: calling into Ruby, raising through its own frames (a
 * longjmp, which is a WebAssembly exception that crosses modules), a block,
 * and objects held only in this module's locals while the collector runs,
 * which it sees because the module went through --spill-pointers too.
 */
#include <ruby.h>

/* a + b, by calling `+` on a. */
static VALUE
check_add(VALUE self, VALUE a, VALUE b)
{
    return rb_funcall(a, rb_intern("+"), 1, b);
}

/* Raises ArgumentError from here. */
static VALUE
check_raise(VALUE self)
{
    rb_raise(rb_eArgError, "raised in C");
    return Qnil;
}

/* Yields 1, 2 and 3, and returns the sum of what the block returned; an
 * exception the block raises goes through this frame. */
static VALUE
check_each(VALUE self)
{
    long i, sum = 0;
    for (i = 1; i <= 3; i++) {
        sum += NUM2LONG(rb_yield(LONG2NUM(i)));
    }
    return LONG2NUM(sum);
}

/* Makes `n` strings, each held only in a local of this function while the
 * collector runs, then checks every one is still intact. A collector that
 * could not see them would free them, and their slots would be reused. */
static VALUE
check_churn(VALUE self, VALUE count)
{
    long i, n = NUM2LONG(count);
    VALUE kept = rb_ary_new();
    for (i = 0; i < n; i++) {
        VALUE s = rb_sprintf("string %ld", i);
        VALUE junk = rb_ary_new_capa(64);
        rb_gc();
        rb_ary_push(junk, rb_str_new_cstr("junk"));
        rb_ary_push(kept, s);
    }
    for (i = 0; i < n; i++) {
        VALUE s = rb_ary_entry(kept, i);
        VALUE want = rb_sprintf("string %ld", i);
        if (!RB_TYPE_P(s, T_STRING) || !rb_str_equal(s, want)) {
            rb_raise(rb_eRuntimeError, "string %ld was collected while held", i);
        }
    }
    return LONG2NUM(n);
}

void
Init_wasix_check(void)
{
    VALUE mod = rb_define_module("WasixCheck");
    rb_define_module_function(mod, "add", check_add, 2);
    rb_define_module_function(mod, "raise_in_c", check_raise, 0);
    rb_define_module_function(mod, "each_sum", check_each, 0);
    rb_define_module_function(mod, "churn", check_churn, 1);
}
