package com.sentrifugo.security.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisPassword;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

/**
 * Connection to the Valkey instance IAM writes sessions to. It must be the
 * same instance (and database index) IAM uses, or no session will be found.
 */
@Configuration
public class ValkeyConfig {

    @Bean
    public LettuceConnectionFactory redisConnectionFactory(
            @Value("${spring.data.redis.host:localhost}") String host,
            @Value("${spring.data.redis.port:6379}") int port,
            @Value("${spring.data.redis.username:}") String username,
            @Value("${spring.data.redis.password:}") String password,
            @Value("${spring.data.redis.database:0}") int database,
            @Value("${spring.data.redis.ssl.enabled:false}") boolean ssl) {

        RedisStandaloneConfiguration redisConfig =
                new RedisStandaloneConfiguration();

        redisConfig.setHostName(host.trim());
        redisConfig.setPort(port);
        redisConfig.setDatabase(database);
        if (!username.isBlank()) {
            redisConfig.setUsername(username);
        }
        if (!password.isBlank()) {
            redisConfig.setPassword(RedisPassword.of(password));
        }

        LettuceClientConfiguration.LettuceClientConfigurationBuilder clientConfig =
                LettuceClientConfiguration.builder();
        if (ssl) {
            clientConfig.useSsl();
        }

        return new LettuceConnectionFactory(
                redisConfig,
                clientConfig.build()
        );
    }

    @Bean
    public StringRedisTemplate stringRedisTemplate(
            LettuceConnectionFactory connectionFactory) {

        return new StringRedisTemplate(connectionFactory);
    }
}
