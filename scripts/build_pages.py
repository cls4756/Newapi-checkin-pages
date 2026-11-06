"""只发布白名单静态文件，避免将私密仓库文件带入 GitHub Pages。"""

import argparse
import shutil
from pathlib import Path


PUBLIC_FILES = (
    'index.html',
    'config_generator.html',
    'dashboard.html',
    'account_table.js',
    'account_table.css',
    'account_exports.js',
    'github_config_ui.js',
    'github_settings.js',
    'sync_settings_ui.js',
    'github_browser_config.js',
    'vendor/libsodium.js',
    'vendor/libsodium-wrappers.js',
    'vendor/LICENSE.libsodium',
)


def build_pages(project_dir, output_dir):
    project_dir = Path(project_dir).resolve()
    output_path = Path(output_dir)
    if output_path.is_symlink():
        raise ValueError('Pages 输出目录不能是符号链接')
    output_dir = output_path.resolve()
    if output_dir == project_dir or output_dir in project_dir.parents:
        raise ValueError('Pages 输出目录不能覆盖项目或其父目录')
    sources = []
    for relative_path in PUBLIC_FILES:
        source = project_dir
        for component in Path(relative_path).parts:
            source = source / component
            if source.is_symlink():
                raise ValueError('Pages 白名单文件及目录不能是符号链接')
        if not source.is_file():
            raise ValueError('缺少 Pages 白名单文件：' + relative_path)
        if source == output_dir or output_dir in source.parents:
            raise ValueError('Pages 输出目录不能覆盖源文件')
        sources.append((source, relative_path))
    if output_dir.exists():
        if not output_dir.is_dir():
            raise ValueError('Pages 输出路径必须是目录')
        shutil.rmtree(str(output_dir))
    output_dir.mkdir(parents=True)
    for source, relative_path in sources:
        destination = output_dir / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(str(source), str(destination))
    (output_dir / '.nojekyll').write_text('', encoding='utf-8')
    return list(PUBLIC_FILES) + ['.nojekyll']


def main():
    project_dir = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description='构建只包含白名单静态文件的 GitHub Pages 产物')
    parser.add_argument('--output', default=str(project_dir / '_site'))
    arguments = parser.parse_args()
    files = build_pages(project_dir, arguments.output)
    print('Pages 静态文件已准备，共 {} 个文件；未读取或发布 .env 和账号配置。'.format(len(files)))


if __name__ == '__main__':
    main()
