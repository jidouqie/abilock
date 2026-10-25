#import <Foundation/Foundation.h>

/* The desktop shell accepts only a public URL produced by its own child.
   Neither credentials nor executable instructions cross this boundary. */
NSURL *ABLConfigurationURL(id value);
NSURL *ABLReadyURL(NSData *line);
BOOL ABLSameOrigin(NSURL *candidate, NSURL *origin);
void ABLObserveReadiness(NSFileHandle *handle, void (^receive)(NSData *));
