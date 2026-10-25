using System.Diagnostics;
using System.Text;

namespace Abilock.Desktop;

internal static class DesktopProcess
{
    internal static async Task WaitForExitAsync(Process process, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        var completed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        EventHandler exited = (_, _) => completed.TrySetResult(true);
        process.EnableRaisingEvents = true;
        process.Exited += exited;
        try
        {
            using (cancellation.Register(() => completed.TrySetCanceled()))
            {
                if (process.HasExited) return;
                await completed.Task.ConfigureAwait(false);
            }
        }
        finally { process.Exited -= exited; }
    }

    private static async Task<string> ReadLineAsync(StreamReader output)
    {
        var text = new StringBuilder();
        var character = new char[1];
        while (text.Length < 4096)
        {
            if (await output.ReadAsync(character, 0, 1).ConfigureAwait(false) == 0)
                throw new InvalidOperationException("READINESS_EOF");
            if (character[0] == '\n') return text.Length > 0 && text[text.Length - 1] == '\r'
                ? text.ToString(0, text.Length - 1) : text.ToString();
            text.Append(character[0]);
        }
        throw new InvalidOperationException("READINESS_LIMIT");
    }

    internal static async Task<string> ReadBoundedLineAsync(StreamReader output, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        var reading = ReadLineAsync(output);
        var cancelled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using (cancellation.Register(() => cancelled.TrySetResult(true)))
        {
            if (await Task.WhenAny(reading, cancelled.Task).ConfigureAwait(false) != reading)
            {
                // Closing the owned process/pipe ends the pending Framework
                // read. Observe its eventual fault without blocking shutdown.
                _ = reading.ContinueWith(task => { _ = task.Exception; }, CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
                throw new OperationCanceledException(cancellation);
            }
            return await reading.ConfigureAwait(false);
        }
    }

    internal static async Task StopOwnedAsync(Process process, int gracefulMilliseconds = 8000)
    {
        process.StandardInput.Close();
        using (var deadline = new CancellationTokenSource(gracefulMilliseconds))
        {
            try { await WaitForExitAsync(process, deadline.Token).ConfigureAwait(false); }
            catch (OperationCanceledException)
            {
                // This is the existing process handle, never a process search
                // or whole-tree kill. The protected host owns worker cleanup.
                if (!process.HasExited) process.Kill();
                using (var finalDeadline = new CancellationTokenSource(5000))
                    await WaitForExitAsync(process, finalDeadline.Token).ConfigureAwait(false);
            }
        }
    }
}
