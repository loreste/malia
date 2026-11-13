#define NAPI_VERSION 9
#include <node_api.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(expr)                                                    \
  do {                                                                 \
    if ((expr) != napi_ok) {                                           \
      napi_throw_error(env, NULL, "N-API call failed: " #expr);        \
      return NULL;                                                     \
    }                                                                  \
  } while (0)

// 1. Add two numbers + cb_info + handle scope
static napi_value Add(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));

  double a = 0, b = 0;
  CHECK(napi_get_value_double(env, args[0], &a));
  CHECK(napi_get_value_double(env, args[1], &b));

  napi_handle_scope scope;
  CHECK(napi_open_handle_scope(env, &scope));
  napi_escapable_handle_scope esc;
  CHECK(napi_open_escapable_handle_scope(env, &esc));

  napi_value sum;
  CHECK(napi_create_double(env, a + b, &sum));
  napi_value escaped;
  CHECK(napi_escape_handle(env, esc, sum, &escaped));

  CHECK(napi_close_escapable_handle_scope(env, esc));
  CHECK(napi_close_handle_scope(env, scope));
  return escaped;
}

// 2. Strings (UTF-8, UTF-16, Latin1)
static napi_value EchoStrings(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  CHECK(napi_get_cb_info(env, info, &argc, &arg, NULL, NULL));

  size_t len = 0;
  CHECK(napi_get_value_string_utf8(env, arg, NULL, 0, &len));
  char* buf = (char*)malloc(len + 1);
  CHECK(napi_get_value_string_utf8(env, arg, buf, len + 1, &len));

  napi_value out;
  CHECK(napi_create_object(env, &out));

  napi_value u8;
  CHECK(napi_create_string_utf8(env, buf, len, &u8));
  CHECK(napi_set_named_property(env, out, "utf8", u8));
  free(buf);

  uint16_t u16_data[] = { 'h', 'i', 0x2603 };
  napi_value u16;
  CHECK(napi_create_string_utf16(env, u16_data, 3, &u16));
  CHECK(napi_set_named_property(env, out, "utf16", u16));

  napi_value l1;
  CHECK(napi_create_string_latin1(env, "abc", 3, &l1));
  CHECK(napi_set_named_property(env, out, "latin1", l1));

  return out;
}

// 3. BigInt & Date & Symbol & Typeof
static napi_value TestTypes(napi_env env, napi_callback_info info) {
  napi_value out;
  CHECK(napi_create_object(env, &out));

  napi_value bi;
  CHECK(napi_create_bigint_int64(env, -9007199254740993LL, &bi));
  int64_t bi_val = 0;
  bool lossless = false;
  CHECK(napi_get_value_bigint_int64(env, bi, &bi_val, &lossless));
  CHECK(napi_set_named_property(env, out, "bigint", bi));

  napi_value dt;
  CHECK(napi_create_date(env, 1700000000000.0, &dt));
  bool is_dt = false;
  CHECK(napi_is_date(env, dt, &is_dt));
  CHECK(napi_set_named_property(env, out, "date", dt));

  napi_value sym;
  CHECK(node_api_symbol_for(env, "malia.napi.sym", NAPI_AUTO_LENGTH, &sym));
  CHECK(napi_set_named_property(env, out, "sym", sym));

  napi_value arr;
  CHECK(napi_create_array_with_length(env, 2, &arr));
  napi_value v0, v1;
  CHECK(napi_create_int32(env, 10, &v0));
  CHECK(napi_create_int32(env, 20, &v1));
  CHECK(napi_set_element(env, arr, 0, v0));
  CHECK(napi_set_element(env, arr, 1, v1));
  CHECK(napi_set_named_property(env, out, "arr", arr));

  return out;
}

// 4. Buffer, ArrayBuffer, TypedArray, DataView
static napi_value TestBuffers(napi_env env, napi_callback_info info) {
  napi_value out;
  CHECK(napi_create_object(env, &out));

  const char msg[] = "hello-napi";
  napi_value buf;
  void* buf_data = NULL;
  CHECK(napi_create_buffer_copy(env, sizeof(msg) - 1, msg, &buf_data, &buf));
  CHECK(napi_set_named_property(env, out, "buf", buf));

  napi_value ab;
  void* ab_data = NULL;
  CHECK(napi_create_arraybuffer(env, 16, &ab_data, &ab));
  memset(ab_data, 0, 16);
  ((int32_t*)ab_data)[0] = 42;
  ((int32_t*)ab_data)[1] = 99;

  napi_value ta;
  CHECK(napi_create_typedarray(env, napi_int32_array, 4, ab, 0, &ta));
  CHECK(napi_set_named_property(env, out, "ta", ta));

  napi_value dv;
  CHECK(napi_create_dataview(env, 8, ab, 0, &dv));
  CHECK(napi_set_named_property(env, out, "dv", dv));

  return out;
}

// 5. Class + Wrap + Unwrap + TypeTag + Getter/Setter + Static method
typedef struct {
  int value;
} CounterData;

static const napi_type_tag COUNTER_TAG = {
  0x123456789abcdef0ULL,
  0x0fedcba987654321ULL,
};

static void CounterFinalize(napi_env env, void* data, void* hint) {
  free(data);
}

static napi_value CounterCtor(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_value this_arg;
  CHECK(napi_get_cb_info(env, info, &argc, &arg, &this_arg, NULL));

  int32_t initial = 0;
  if (argc >= 1) {
    CHECK(napi_get_value_int32(env, arg, &initial));
  }

  CounterData* cd = (CounterData*)malloc(sizeof(CounterData));
  cd->value = initial;
  CHECK(napi_wrap(env, this_arg, cd, CounterFinalize, NULL, NULL));
  CHECK(napi_type_tag_object(env, this_arg, &COUNTER_TAG));
  return this_arg;
}

static napi_value CounterInc(napi_env env, napi_callback_info info) {
  napi_value this_arg;
  CHECK(napi_get_cb_info(env, info, NULL, NULL, &this_arg, NULL));

  bool tagged = false;
  CHECK(napi_check_object_type_tag(env, this_arg, &COUNTER_TAG, &tagged));
  if (!tagged) {
    napi_throw_type_error(env, NULL, "Expected Counter instance");
    return NULL;
  }

  CounterData* cd = NULL;
  CHECK(napi_unwrap(env, this_arg, (void**)&cd));
  cd->value += 1;

  napi_value res;
  CHECK(napi_create_int32(env, cd->value, &res));
  return res;
}

static napi_value CounterGetVal(napi_env env, napi_callback_info info) {
  napi_value this_arg;
  CHECK(napi_get_cb_info(env, info, NULL, NULL, &this_arg, NULL));
  CounterData* cd = NULL;
  CHECK(napi_unwrap(env, this_arg, (void**)&cd));
  napi_value res;
  CHECK(napi_create_int32(env, cd->value, &res));
  return res;
}

static napi_value CounterStaticMake(napi_env env, napi_callback_info info) {
  napi_value v;
  CHECK(napi_create_int32(env, 77, &v));
  return v;
}

// 6. Callback invocation & Errors
static napi_value CallWithTry(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));

  napi_value undef;
  CHECK(napi_get_undefined(env, &undef));
  napi_value res;
  napi_status st = napi_call_function(env, undef, args[0], 1, &args[1], &res);
  if (st == napi_pending_exception) {
    napi_value exc;
    CHECK(napi_get_and_clear_last_exception(env, &exc));
    return exc;
  }
  return res;
}

// 7. Promise + AsyncWork
typedef struct {
  napi_deferred deferred;
  napi_async_work work;
  int32_t input;
  int32_t output;
} AsyncSquareData;

static void ExecuteSquare(napi_env env, void* data) {
  AsyncSquareData* d = (AsyncSquareData*)data;
  d->output = d->input * d->input;
}

static void CompleteSquare(napi_env env, napi_status status, void* data) {
  AsyncSquareData* d = (AsyncSquareData*)data;
  napi_value res;
  napi_create_int32(env, d->output, &res);
  napi_resolve_deferred(env, d->deferred, res);
  napi_delete_async_work(env, d->work);
  free(d);
}

static napi_value AsyncSquare(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  CHECK(napi_get_cb_info(env, info, &argc, &arg, NULL, NULL));

  int32_t val = 0;
  CHECK(napi_get_value_int32(env, arg, &val));

  AsyncSquareData* d = (AsyncSquareData*)malloc(sizeof(AsyncSquareData));
  d->input = val;
  d->output = 0;

  napi_value promise;
  CHECK(napi_create_promise(env, &d->deferred, &promise));

  napi_value name;
  CHECK(napi_create_string_utf8(env, "AsyncSquare", NAPI_AUTO_LENGTH, &name));
  CHECK(napi_create_async_work(env, NULL, name, ExecuteSquare, CompleteSquare, d, &d->work));
  CHECK(napi_queue_async_work(env, d->work));
  return promise;
}

// 8. ThreadsafeFunction
typedef struct {
  napi_threadsafe_function tsfn;
  int count;
} TsfnTestData;

static void TsfnCallJs(napi_env env, napi_value js_cb, void* context, void* data) {
  int val = (int)(intptr_t)data;
  napi_value arg, undef;
  napi_get_undefined(env, &undef);
  napi_create_int32(env, val, &arg);
  napi_call_function(env, undef, js_cb, 1, &arg, NULL);
}

static void* TsfnWorker(void* arg) {
  TsfnTestData* td = (TsfnTestData*)arg;
  for (int i = 1; i <= td->count; i++) {
    napi_call_threadsafe_function(td->tsfn, (void*)(intptr_t)(i * 10), napi_tsfn_blocking);
  }
  napi_release_threadsafe_function(td->tsfn, napi_tsfn_release);
  free(td);
  return NULL;
}

static napi_value RunTsfn(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));

  int32_t count = 3;
  CHECK(napi_get_value_int32(env, args[1], &count));

  napi_value name;
  CHECK(napi_create_string_utf8(env, "TsfnTest", NAPI_AUTO_LENGTH, &name));

  TsfnTestData* td = (TsfnTestData*)malloc(sizeof(TsfnTestData));
  td->count = count;
  CHECK(napi_create_threadsafe_function(
      env, args[0], NULL, name, 0, 1, NULL, NULL, NULL, TsfnCallJs, &td->tsfn));

  pthread_t th;
  pthread_create(&th, NULL, TsfnWorker, td);
  pthread_detach(th);

  napi_value undef;
  CHECK(napi_get_undefined(env, &undef));
  return undef;
}

// 9. Instance data & Version
static napi_value GetMeta(napi_env env, napi_callback_info info) {
  uint32_t ver = 0;
  CHECK(napi_get_version(env, &ver));

  const char* secret = "malia-instance-data";
  CHECK(napi_set_instance_data(env, (void*)secret, NULL, NULL));
  void* got = NULL;
  CHECK(napi_get_instance_data(env, &got));

  napi_value out, v_ver, v_inst;
  CHECK(napi_create_object(env, &out));
  CHECK(napi_create_uint32(env, ver, &v_ver));
  CHECK(napi_create_string_utf8(env, (const char*)got, NAPI_AUTO_LENGTH, &v_inst));
  CHECK(napi_set_named_property(env, out, "version", v_ver));
  CHECK(napi_set_named_property(env, out, "instanceData", v_inst));
  return out;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor counter_props[] = {
    { "inc", NULL, CounterInc, NULL, NULL, NULL, napi_default_method, NULL },
    { "value", NULL, NULL, CounterGetVal, NULL, NULL, napi_default_jsproperty, NULL },
    { "magic", NULL, CounterStaticMake, NULL, NULL, NULL, napi_static, NULL },
  };
  napi_value counter_cls;
  if (napi_define_class(env, "Counter", NAPI_AUTO_LENGTH, CounterCtor, NULL, 3, counter_props, &counter_cls) != napi_ok) {
    return NULL;
  }

  napi_property_descriptor exports_props[] = {
    { "add", NULL, Add, NULL, NULL, NULL, napi_default_method, NULL },
    { "echoStrings", NULL, EchoStrings, NULL, NULL, NULL, napi_default_method, NULL },
    { "testTypes", NULL, TestTypes, NULL, NULL, NULL, napi_default_method, NULL },
    { "testBuffers", NULL, TestBuffers, NULL, NULL, NULL, napi_default_method, NULL },
    { "callWithTry", NULL, CallWithTry, NULL, NULL, NULL, napi_default_method, NULL },
    { "asyncSquare", NULL, AsyncSquare, NULL, NULL, NULL, napi_default_method, NULL },
    { "runTsfn", NULL, RunTsfn, NULL, NULL, NULL, napi_default_method, NULL },
    { "getMeta", NULL, GetMeta, NULL, NULL, NULL, napi_default_method, NULL },
    { "Counter", NULL, NULL, NULL, NULL, counter_cls, napi_default_jsproperty, NULL },
  };
  if (napi_define_properties(env, exports, 9, exports_props) != napi_ok) {
    return NULL;
  }
  return exports;
}

