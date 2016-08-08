# nos-init

NodeOS provides a powerful kernel image that bundles NodeJS with the Linux
kernel. `nos-init` can be used to bundle up a NodeJS module into an initramfs
that can be used along side the NodeOS kernel.

Run `nos-init` in the directory containing the package.json, or provide the path
to said directory on the commandline. `nos-init` will produce on `stdout` the
compressed cpio file; use your shell to redirect it to a file.

`nos-init` walks the indicated directory, including all the files and
subdirectories, and additionally produces the file /sbin/init. This is set to
run the script pointed to by 'main' in the package.json file, or failing that,
server.js or index.js.
