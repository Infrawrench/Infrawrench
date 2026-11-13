// kubectl, as Kubernetes' own cmd/kubectl builds it, for builtin:kubectl.
package main

import (
	"os"

	"k8s.io/component-base/cli"
	"k8s.io/kubectl/pkg/cmd"
	"k8s.io/kubectl/pkg/cmd/util"
)

func main() {
	command := cmd.NewDefaultKubectlCommand()
	if err := cli.RunNoErrOutput(command); err != nil {
		util.CheckErr(err)
	}
	os.Exit(0)
}
