<?php
/**
 * A PHP page mounting an ogygia app — no JavaScript toolchain on this host at all.
 * The MFE's fragment endpoint answers a JSON document {status, title, css[], body, runtime};
 * this page prints it and loads the MFE's OWN runtime script, which wakes the islands.
 * Run: php -S 127.0.0.1:5185 (with the cms app running on :5182)
 */
$CMS = getenv('CMS_ORIGIN') ?: 'http://127.0.0.1:5182';
$path = $_GET['p'] ?? '/';

$ctx = stream_context_create(['http' => ['timeout' => 3]]);
$raw = @file_get_contents("$CMS/og/fragment/page?path=" . rawurlencode($path), false, $ctx);
$doc = $raw ? json_decode($raw, true) : null;

if ($doc && !empty($doc['location'])) {          // follow the MFE's redirects, rebased to this host
    header('Location: /?p=' . rawurlencode($doc['location']), true, $doc['status']);
    exit;
}
http_response_code($doc['status'] ?? 503);
?><!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title><?= htmlspecialchars($doc['title'] ?? 'ACME (PHP)') ?: 'ACME (PHP)' ?></title>
  <?= $doc ? implode("\n  ", $doc['css']) : '' ?>
  <?php if ($doc && !empty($doc['runtime'])): ?>
  <script type="module" src="<?= htmlspecialchars($doc['runtime']) ?>"></script>
  <?php endif; ?>
  <style>body{font-family:system-ui;max-width:720px;margin:2rem auto} .chrome{background:#1d4ed8;color:#fff;padding:.6rem 1rem;border-radius:8px}</style>
</head>
<body>
  <nav class="chrome"><strong>Legacy PHP host</strong> — everything below is the ogygia CMS</nav>
  <?php if ($doc): ?>
    <?= $doc['body'] ?>
  <?php else: ?>
    <div style="border:2px dashed #dc2626;padding:1rem;color:#dc2626">CMS unreachable — rest of this page is unaffected.</div>
  <?php endif; ?>
</body>
</html>
