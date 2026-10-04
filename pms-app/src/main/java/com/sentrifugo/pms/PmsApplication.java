package com.sentrifugo.pms;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

// pms-security lives under com.sentrifugo.security, a sibling of this class's package, so it must be scanned explicitly.
@SpringBootApplication(scanBasePackages = "com.sentrifugo")
public class PmsApplication {

    public static void main(String[] args) {
        SpringApplication.run(PmsApplication.class, args);
    }
}