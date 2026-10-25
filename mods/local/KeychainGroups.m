// Keychain access groups for a build signed with your own certificate (tools/signing.ts).
// Arc's engine names its passkey and key stores after Arc's team ("S6N382Y83G.company.thebrowser.browser.webauthn"),
// and macOS gives a group only to apps signed by its team. ArcCore's bytes can't change: Widevine checks them against
// ArcCore.sig. So the browser process's keychain calls are redirected here to the same groups under the team this
// build is signed for, and the entitlement check Chromium makes before offering Touch ID sees Arc's names as granted.
// Ad hoc builds have no team identifier, and nothing changes.
#import <Foundation/Foundation.h>
#import <Security/Security.h>

static NSString *const kArcTeamGroupPrefix = @"S6N382Y83G.company.thebrowser.browser.";
static NSString *const kGroupSuffix = @".company.thebrowser.browser.";

static NSString *ArcModSignedTeam(void) {
	static NSString *team;
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
		if (!task) return;
		id value = CFBridgingRelease(SecTaskCopyValueForEntitlement(task, CFSTR("com.apple.developer.team-identifier"), NULL));
		CFRelease(task);
		if ([value isKindOfClass:NSString.class] && [value length] == 10) team = value;
	});
	return team;
}

static id ArcModRetargetGroup(id group, NSString *team) {
	if (![group isKindOfClass:NSString.class] || ![group hasPrefix:kArcTeamGroupPrefix]) return group;
	return [NSString stringWithFormat:@"%@%@%@", team, kGroupSuffix, [group substringFromIndex:kArcTeamGroupPrefix.length]];
}

// Returns a retained copy of `attributes` with Arc's groups renamed (at the top level and in the key-pair attribute
// dictionaries SecKeyCreateRandomKey takes), or NULL when there is nothing to rename.
static CFDictionaryRef ArcModCopyRetargeted(CFDictionaryRef attributes) {
	NSString *team = ArcModSignedTeam();
	if (!team || !attributes) return NULL;
	NSDictionary *original = (__bridge NSDictionary *)attributes;
	NSMutableDictionary *copy = [original mutableCopy];
	BOOL changed = NO;
	id group = original[(__bridge id)kSecAttrAccessGroup];
	id renamed = ArcModRetargetGroup(group, team);
	if (renamed != group) {
		copy[(__bridge id)kSecAttrAccessGroup] = renamed;
		changed = YES;
	}
	for (id key in @[(__bridge id)kSecPrivateKeyAttrs, (__bridge id)kSecPublicKeyAttrs]) {
		NSDictionary *nested = original[key];
		if (![nested isKindOfClass:NSDictionary.class]) continue;
		CFDictionaryRef retargeted = ArcModCopyRetargeted((__bridge CFDictionaryRef)nested);
		if (!retargeted) continue;
		copy[key] = CFBridgingRelease(retargeted);
		changed = YES;
	}
	return changed ? (CFDictionaryRef)CFBridgingRetain(copy) : NULL;
}

static OSStatus ArcModSecItemAdd(CFDictionaryRef attributes, CFTypeRef *result) {
	CFDictionaryRef retargeted = ArcModCopyRetargeted(attributes);
	OSStatus status = SecItemAdd(retargeted ?: attributes, result);
	if (retargeted) CFRelease(retargeted);
	return status;
}

static OSStatus ArcModSecItemCopyMatching(CFDictionaryRef query, CFTypeRef *result) {
	CFDictionaryRef retargeted = ArcModCopyRetargeted(query);
	OSStatus status = SecItemCopyMatching(retargeted ?: query, result);
	if (retargeted) CFRelease(retargeted);
	return status;
}

static OSStatus ArcModSecItemUpdate(CFDictionaryRef query, CFDictionaryRef attributesToUpdate) {
	CFDictionaryRef retargeted = ArcModCopyRetargeted(query);
	OSStatus status = SecItemUpdate(retargeted ?: query, attributesToUpdate);
	if (retargeted) CFRelease(retargeted);
	return status;
}

static OSStatus ArcModSecItemDelete(CFDictionaryRef query) {
	CFDictionaryRef retargeted = ArcModCopyRetargeted(query);
	OSStatus status = SecItemDelete(retargeted ?: query);
	if (retargeted) CFRelease(retargeted);
	return status;
}

static SecKeyRef ArcModSecKeyCreateRandomKey(CFDictionaryRef parameters, CFErrorRef *error) {
	CFDictionaryRef retargeted = ArcModCopyRetargeted(parameters);
	SecKeyRef key = SecKeyCreateRandomKey(retargeted ?: parameters, error);
	if (retargeted) CFRelease(retargeted);
	return key;
}

// Chromium offers Touch ID only when the app is entitled to the group it uses; report Arc's names alongside ours.
static CFTypeRef ArcModSecTaskCopyValueForEntitlement(SecTaskRef task, CFStringRef entitlement, CFErrorRef *error) {
	CFTypeRef value = SecTaskCopyValueForEntitlement(task, entitlement, error);
	NSString *team = ArcModSignedTeam();
	if (!team || !value || !entitlement || CFStringCompare(entitlement, CFSTR("keychain-access-groups"), 0) != kCFCompareEqualTo ||
		CFGetTypeID(value) != CFArrayGetTypeID()) return value;
	NSArray *granted = CFBridgingRelease(value);
	NSMutableArray *reported = [granted mutableCopy];
	NSString *ours = [team stringByAppendingString:kGroupSuffix];
	for (id group in granted)
		if ([group isKindOfClass:NSString.class] && [group hasPrefix:ours])
			[reported addObject:[kArcTeamGroupPrefix stringByAppendingString:[group substringFromIndex:ours.length]]];
	return CFBridgingRetain(reported);
}

__attribute__((used)) static const struct { const void *replacement; const void *original; }
	kArcModKeychainInterpose[] __attribute__((section("__DATA,__interpose"))) = {
		{(const void *)ArcModSecItemAdd, (const void *)SecItemAdd},
		{(const void *)ArcModSecItemCopyMatching, (const void *)SecItemCopyMatching},
		{(const void *)ArcModSecItemUpdate, (const void *)SecItemUpdate},
		{(const void *)ArcModSecItemDelete, (const void *)SecItemDelete},
		{(const void *)ArcModSecKeyCreateRandomKey, (const void *)SecKeyCreateRandomKey},
		{(const void *)ArcModSecTaskCopyValueForEntitlement, (const void *)SecTaskCopyValueForEntitlement},
	};
