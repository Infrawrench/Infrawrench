#ifndef NAPI_V8_EDGE_V8_PLATFORM_H_
#define NAPI_V8_EDGE_V8_PLATFORM_H_

#include <chrono>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

#include <v8-platform.h>

#include "unofficial_napi.h"

class EdgeV8Platform final : public v8::Platform {
 public:
  struct FinishedCallback;
  struct IsolateState;

  static std::unique_ptr<EdgeV8Platform> Create();

  // Sets how many background worker threads the platform gets. Zero restores
  // V8's own default, which sizes the pool from the host's processor count --
  // reasonable for a process running one JS app, less so for a host running
  // many, where those threads compete with every tenant's foreground JS and
  // their work is not attributed to anyone.
  //
  // The pool is process-wide and built when the first isolate is created, so
  // this has no effect afterwards; it returns false in that case.
  static bool SetWorkerThreadCount(int count);

  // iwci patch (#938): lets the embedder attribute worker tasks, which run
  // on the process-wide pool, to whoever posted them. `capture` runs on the
  // posting thread and returns a token (or null for "no one"); `enter` and
  // `exit` run on the worker thread around the task, and tell the embedder
  // that until `exit` this thread works for the token's owner (so a task
  // posted from inside one is captured for the same owner); `release` frees
  // the token when the task is destroyed, run or not. Process-wide; set
  // before the first isolate is created.
  static void SetWorkerTaskHooks(void* (*capture)(),
                                 void (*enter)(void*),
                                 void (*exit)(void*),
                                 void (*release)(void*));

  ~EdgeV8Platform() override;

  bool RegisterIsolate(v8::Isolate* isolate);
  void AddIsolateFinishedCallback(v8::Isolate* isolate,
                                  void (*callback)(void*),
                                  void* data);
  void NotifyIsolateShutdown(v8::Isolate* isolate);
  void DisposeIsolate(v8::Isolate* isolate);
  void UnregisterIsolate(v8::Isolate* isolate);
  bool BindForegroundTaskTarget(v8::Isolate* isolate,
                                napi_env env,
                                unofficial_napi_enqueue_foreground_task_callback callback,
                                void* target);
  void ClearForegroundTaskTarget(v8::Isolate* isolate, napi_env env);
  void AddPendingForegroundTask(const std::shared_ptr<IsolateState>& state);
  void CompletePendingForegroundTask(const std::shared_ptr<IsolateState>& state);
  // iwci patch: returns whether it ran a task.
  bool PumpPendingForegroundTasks(v8::Isolate* isolate);

  // iwci patch: what an isolate's event loop waits for (#943). Worker tasks
  // are attributed to the isolate whose thread posted them (or to the
  // isolate of the worker task that posted them), as Node's DrainTasks
  // counts them; foreground tasks are its own.
  //
  // Whether the isolate has background work queued or running, or an
  // immediate foreground task waiting for the next pump.
  bool HasPendingWork(v8::Isolate* isolate);
  // Blocks the isolate's thread until an immediate foreground task is posted
  // for it, its background work ends, or `timeout` passes, whichever comes
  // first. Returns at once when there is nothing to wait for.
  void WaitForPendingWork(v8::Isolate* isolate, std::chrono::microseconds timeout);

  int NumberOfWorkerThreads() override;
  std::shared_ptr<v8::TaskRunner> GetForegroundTaskRunner(
      v8::Isolate* isolate, v8::TaskPriority priority) override;
  bool IdleTasksEnabled(v8::Isolate* isolate) override;
  double MonotonicallyIncreasingTime() override;
  double CurrentClockTimeMillis() override;
  v8::TracingController* GetTracingController() override;
  v8::PageAllocator* GetPageAllocator() override;
  v8::ThreadIsolatedAllocator* GetThreadIsolatedAllocator() override;
  void OnCriticalMemoryPressure() override;
  void DumpWithoutCrashing() override;
  v8::HighAllocationThroughputObserver* GetHighAllocationThroughputObserver() override;
  StackTracePrinter GetStackTracePrinter() override;
  std::unique_ptr<v8::ScopedBlockingCall> CreateBlockingScope(
      v8::BlockingType blocking_type) override;

 protected:
  std::unique_ptr<v8::JobHandle> CreateJobImpl(
      v8::TaskPriority priority,
      std::unique_ptr<v8::JobTask> job_task,
      const v8::SourceLocation& location) override;
  void PostTaskOnWorkerThreadImpl(v8::TaskPriority priority,
                                  std::unique_ptr<v8::Task> task,
                                  const v8::SourceLocation& location) override;
  void PostDelayedTaskOnWorkerThreadImpl(
      v8::TaskPriority priority,
      std::unique_ptr<v8::Task> task,
      double delay_in_seconds,
      const v8::SourceLocation& location) override;

 private:
  class ForegroundTaskRunner;

  explicit EdgeV8Platform(std::unique_ptr<v8::Platform> fallback);

  std::shared_ptr<IsolateState> EnsureState(v8::Isolate* isolate);
  std::shared_ptr<ForegroundTaskRunner> EnsureRunner(v8::Isolate* isolate);
  std::shared_ptr<IsolateState> GetState(v8::Isolate* isolate);
  void BeginShutdown(const std::shared_ptr<IsolateState>& state);
  void MaybeFinishIsolate(const std::shared_ptr<IsolateState>& state,
                          bool begin_shutdown);
  // iwci patch: the isolate that background work posted now belongs to.
  std::shared_ptr<IsolateState> CurrentWorkOwner();

  std::unique_ptr<v8::Platform> fallback_;
  std::mutex mutex_;
  std::unordered_map<v8::Isolate*, std::shared_ptr<IsolateState>> isolates_;
};

#endif  // NAPI_V8_EDGE_V8_PLATFORM_H_
