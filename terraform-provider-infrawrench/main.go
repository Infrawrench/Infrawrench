// terraform-provider-infrawrench manages Infrawrench's own configuration —
// cost allocation and reporting, monitoring, lifecycle governance, connected
// accounts and access control, and alert delivery.
//
// It is not the "eject to Terraform" exporter, which writes HCL for your cloud
// resources so you can leave, and it is not org config as code, which moves a
// whole organization's configuration as one document. See README.md.
package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/provider"
)

// version is overwritten at release time with -ldflags="-X main.version=…".
var version = "dev"

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run the provider with support for debuggers like delve")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		Address: "registry.terraform.io/Infrawrench/infrawrench",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err)
	}
}
