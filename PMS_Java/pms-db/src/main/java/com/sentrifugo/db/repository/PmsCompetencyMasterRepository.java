package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsCompetencyMasterEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsCompetencyMasterRepository extends JpaRepository<PmsCompetencyMasterEntity, UUID> {

    /** Organisation-scoped lookup: the way to load a row without crossing tenants. */
    Optional<PmsCompetencyMasterEntity> findByIdAndOrganisationId(UUID id, String organisationId);

    List<PmsCompetencyMasterEntity> findByOrganisationIdAndIsActiveTrueOrderByCreatedDateAsc(String organisationId);

    List<PmsCompetencyMasterEntity> findByOrganisationIdAndIdIn(String organisationId, Collection<UUID> ids);

    boolean existsByOrganisationIdAndNameIgnoreCaseAndIsActiveTrue(String organisationId, String name);

    boolean existsByOrganisationIdAndNameIgnoreCaseAndIsActiveTrueAndIdNot(String organisationId, String name, UUID id);
}
